import os from "node:os";
import { createHash } from "node:crypto";
import { rename, statfs, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  type ControlMessage,
  type CommandPayload,
  type NodeStats,
} from "@deers/shared/protocol";
import { DockerProvider } from "./providers/docker";
import { applyUpdate, rollback } from "./updater";
import type { ServerProvider } from "./providers/provider";

const exec = promisify(execFile);

const AGENT_VERSION = "1.0.0";
const PANEL_URL = requireEnv("DEERS_PANEL_URL"); // wss://panel.example.com/agent
const NODE_ID = requireEnv("DEERS_NODE_ID");
const TOKEN = requireEnv("DEERS_NODE_TOKEN");
const DATA_ROOT = process.env.DEERS_DATA_ROOT ?? "/var/lib/deers/servers";

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`[agent] missing required environment variable ${key}`);
    process.exit(1);
  }
  return v;
}

const provider: ServerProvider = new DockerProvider();

let ws: WebSocket | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;
let shuttingDown = false;

/** serverId -> detach function, for consoles the panel is currently watching. */
const consoleAttachments = new Map<string, () => void>();

/* ------------------------------ connection ------------------------------ */

function connect() {
  if (shuttingDown) return;
  const url = `${PANEL_URL.replace(/\/$/, "")}`;
  console.log(`[agent] connecting to ${url}`);

  ws = new WebSocket(url, {
    // The agent dials out, so the node needs no inbound ports and no static IP.
    handshakeTimeout: 15_000,
    rejectUnauthorized: process.env.DEERS_INSECURE_TLS !== "true",
  });

  ws.on("open", async () => {
    reconnectAttempt = 0;
    send({
      type: "hello",
      protocol: PROTOCOL_VERSION,
      agentVersion: AGENT_VERSION,
      token: TOKEN,
      nodeId: NODE_ID,
      system: await describeSystem(),
    });
  });

  ws.on("message", async (raw) => {
    let msg: ControlMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "hello.ack") {
      console.log(`[agent] authenticated; ${msg.expectedServers.length} servers expected`);
      startHeartbeat(msg.heartbeatIntervalMs);
      await reconcile(msg.expectedServers);
      void checkForUpdate();
      return;
    }
    if (msg.type === "command") {
      await handleCommand(msg.id, msg.payload);
    }
  });

  ws.on("close", (code, reason) => {
    console.warn(`[agent] disconnected (${code} ${reason.toString()})`);
    stopHeartbeat();
    scheduleReconnect();
  });

  ws.on("error", (err) => console.error(`[agent] socket error: ${err.message}`));
}

/** Exponential backoff with jitter, capped at 60s — a flapping panel never gets hammered. */
function scheduleReconnect() {
  if (shuttingDown) return;
  reconnectAttempt++;
  const base = Math.min(60_000, 1000 * 2 ** Math.min(reconnectAttempt, 6));
  const delay = base / 2 + Math.random() * (base / 2);
  console.log(`[agent] reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt})`);
  setTimeout(connect, delay);
}

function send(msg: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function reply(id: string, ok: boolean, data?: unknown, error?: { code: string; message: string }) {
  send({ type: "result", id, ok, data, error });
}

/* ------------------------------ heartbeat ------------------------------ */

function startHeartbeat(intervalMs: number) {
  stopHeartbeat();
  const beat = async () => {
    try {
      send({
        type: "heartbeat",
        at: Date.now(),
        stats: await collectStats(),
        containers: await provider.listServers(),
      });
    } catch (err) {
      console.error(`[agent] heartbeat failed: ${String(err)}`);
    }
  };
  void beat();
  heartbeatTimer = setInterval(beat, intervalMs);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

let lastCpu = os.cpus();

async function collectStats(): Promise<NodeStats> {
  const current = os.cpus();
  let idle = 0;
  let total = 0;
  for (let i = 0; i < current.length; i++) {
    const prev = lastCpu[i]?.times ?? current[i].times;
    const now = current[i].times;
    const dIdle = now.idle - prev.idle;
    const dTotal =
      now.user - prev.user + (now.nice - prev.nice) + (now.sys - prev.sys) + dIdle + (now.irq - prev.irq);
    idle += dIdle;
    total += dTotal;
  }
  lastCpu = current;
  const cpuPercent = total > 0 ? ((total - idle) / total) * 100 : 0;

  const fsStat = await statfs(DATA_ROOT).catch(() => null);
  const diskTotalMb = fsStat ? Math.round((fsStat.blocks * fsStat.bsize) / 1024 / 1024) : 0;
  const diskFreeMb = fsStat ? Math.round((fsStat.bavail * fsStat.bsize) / 1024 / 1024) : 0;

  return {
    cpuPercent: Number(cpuPercent.toFixed(2)),
    memoryUsedMb: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024),
    memoryTotalMb: Math.round(os.totalmem() / 1024 / 1024),
    diskUsedMb: diskTotalMb - diskFreeMb,
    diskTotalMb,
    loadAvg: os.loadavg() as [number, number, number],
    uptimeSeconds: Math.floor(os.uptime()),
  };
}

async function describeSystem() {
  const stats = await collectStats();
  let dockerVersion: string | null = null;
  try {
    const { stdout } = await exec("docker", ["version", "--format", "{{.Server.Version}}"]);
    dockerVersion = stdout.trim();
  } catch {
    dockerVersion = null;
  }
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuCores: os.cpus().length,
    totalMemoryMb: stats.memoryTotalMb,
    totalDiskMb: stats.diskTotalMb,
    dockerVersion,
  };
}

/* ------------------------------ commands ------------------------------ */

async function handleCommand(id: string, payload: CommandPayload) {
  try {
    switch (payload.op) {
      case "server.create":
        return reply(id, true, await provider.createServer(payload.spec));
      case "server.delete":
        await provider.deleteServer(payload.serverId, payload.wipeVolume);
        detachConsole(payload.serverId);
        return reply(id, true, {});
      case "server.start":
        await provider.startServer(payload.serverId);
        send({ type: "state", serverId: payload.serverId, state: "running" });
        return reply(id, true, {});
      case "server.stop":
        await provider.stopServer(payload.serverId, payload.stopCommand, payload.timeoutSeconds);
        send({ type: "state", serverId: payload.serverId, state: "exited" });
        return reply(id, true, {});
      case "server.restart":
        await provider.restartServer(payload.serverId);
        send({ type: "state", serverId: payload.serverId, state: "running" });
        return reply(id, true, {});
      case "server.kill":
        await provider.killServer(payload.serverId);
        return reply(id, true, {});
      case "server.status":
        return reply(id, true, { state: await provider.getStatus(payload.serverId) });
      case "server.stats":
        return reply(id, true, await provider.getStats(payload.serverId));
      case "server.command":
        await provider.sendCommand(payload.serverId, payload.command);
        return reply(id, true, {});
      case "console.attach":
        await attachConsole(payload.serverId);
        return reply(id, true, {});
      case "console.detach":
        detachConsole(payload.serverId);
        return reply(id, true, {});
      case "files.list":
        return reply(id, true, { entries: await provider.getFiles(payload.serverId, payload.path) });
      case "files.read": {
        const buf = await provider.readFile(payload.serverId, payload.path, payload.maxBytes ?? 2_000_000);
        return reply(id, true, { contentBase64: buf.toString("base64") });
      }
      case "files.write":
        await provider.writeFile(
          payload.serverId,
          payload.path,
          Buffer.from(payload.contentBase64, "base64"),
        );
        return reply(id, true, {});
      case "files.delete":
        await provider.deleteFiles(payload.serverId, payload.paths);
        return reply(id, true, {});
      case "files.mkdir":
        await provider.makeDirectory(payload.serverId, payload.path);
        return reply(id, true, {});
      case "files.rename":
        await provider.renameFile(payload.serverId, payload.from, payload.to);
        return reply(id, true, {});
      case "backup.create":
        return reply(id, true, await provider.createBackup(payload.serverId, payload.backupId));
      case "backup.restore":
        await provider.restoreBackup(payload.serverId, payload.backupId);
        return reply(id, true, {});
      case "backup.delete":
        await provider.deleteBackup(payload.serverId, payload.backupId);
        return reply(id, true, {});
      case "agent.update": {
        const result = await applyUpdate(payload, AGENT_VERSION);
        return reply(id, true, result);
      }
      case "agent.rollback":
        await rollback();
        return reply(id, true, {});
      default:
        return reply(id, false, undefined, { code: "unknown_op", message: "Unsupported operation." });
    }
  } catch (err) {
    console.error(`[agent] ${payload.op} failed:`, err);
    reply(id, false, undefined, { code: "command_failed", message: (err as Error).message });
  }
}

async function attachConsole(serverId: string) {
  if (consoleAttachments.has(serverId)) return;
  const detach = await provider.attachConsole(serverId, (stream, line) => {
    send({ type: "console", serverId, stream, line, at: Date.now() });
  });
  consoleAttachments.set(serverId, detach);
}

function detachConsole(serverId: string) {
  consoleAttachments.get(serverId)?.();
  consoleAttachments.delete(serverId);
}

/**
 * After a reconnect the control plane's view may be stale. Report what actually
 * exists and remove containers the panel no longer knows about (deleted while
 * this node was offline).
 */
async function reconcile(expectedServers: string[]) {
  const actual = await provider.listServers();
  const expected = new Set(expectedServers);

  for (const container of actual) {
    if (!expected.has(container.serverId)) {
      console.warn(`[agent] removing orphaned container for ${container.serverId}`);
      await provider.deleteServer(container.serverId, false).catch(() => undefined);
      continue;
    }
    send({ type: "state", serverId: container.serverId, state: container.state });
  }
}

/* ------------------------------- updates ------------------------------- */

/**
 * Self-update. The agent fetches the published version, and installs it only if
 * the download matches the advertised SHA-256 — the checksum, not the transport,
 * is what makes this safe. systemd restarts us into the new binary.
 *
 * Running game servers are unaffected: containers outlive the agent process.
 */
async function checkForUpdate() {
  if (process.env.DEERS_AUTO_UPDATE === "false") return;

  try {
    const base = PANEL_URL.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/agent$/, "");
    const res = await fetch(`${base}/api/agent/version`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return;

    const release = (await res.json()) as {
      version: string;
      url: string | null;
      sha256: string | null;
    };
    if (!release.url || !release.sha256 || release.version === AGENT_VERSION) return;

    console.log(`[agent] update available: ${AGENT_VERSION} -> ${release.version}`);
    const bundle = Buffer.from(await (await fetch(release.url)).arrayBuffer());
    const digest = createHash("sha256").update(bundle).digest("hex");

    if (digest !== release.sha256) {
      console.error("[agent] update checksum mismatch; refusing to install");
      return;
    }

    // Written beside the running file and swapped in one rename, so a crash
    // mid-write cannot leave a half-copied agent in place.
    const target = process.argv[1];
    await writeFile(`${target}.new`, bundle, { mode: 0o755 });
    await rename(`${target}.new`, target);
    console.log("[agent] update installed; restarting");
    shuttingDown = true;
    ws?.close(1000, "updating");
    setTimeout(() => process.exit(0), 500); // systemd Restart=always brings us back
  } catch (err) {
    console.error("[agent] update check failed:", err);
  }
}

/* ------------------------------ lifecycle ------------------------------ */

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shuttingDown = true;
    stopHeartbeat();
    for (const serverId of consoleAttachments.keys()) detachConsole(serverId);
    ws?.close(1000, "shutdown");
    // Game servers keep running; only the agent stops.
    setTimeout(() => process.exit(0), 500);
  });
}

process.on("unhandledRejection", (err) => console.error("[agent] unhandled rejection:", err));

connect();
