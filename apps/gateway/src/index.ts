import http from "node:http";
import { URL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import Redis from "ioredis";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import {
  PROTOCOL_VERSION,
  type AgentMessage,
  type ControlCommand,
} from "@deers/shared/protocol";

/**
 * The gateway is the only process agents talk to. It holds one outbound-initiated
 * socket per node, authenticates it against the node's hashed token, and bridges
 * commands/replies over Redis so any panel instance can drive any node.
 *
 * It also serves the browser console socket. Browsers authenticate with a
 * short-lived ticket minted by the panel — they never see a node id or token.
 */

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
const redisSub = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");

const PORT = Number(process.env.GATEWAY_PORT ?? 8080);
const HEARTBEAT_INTERVAL_MS = 15_000;
const ONLINE_TTL_SECONDS = 45;

interface AgentConnection {
  nodeId: string;
  socket: WebSocket;
  alive: boolean;
  version: string;
}

const agents = new Map<string, AgentConnection>();
/** serverId -> browser sockets currently watching that console. */
const consoleViewers = new Map<string, Set<WebSocket>>();

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, agents: agents.size }));
    return;
  }
  res.writeHead(404).end();
});

const agentWss = new WebSocketServer({ noServer: true });
const clientWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/agent") {
    agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit("connection", ws, req));
  } else if (url.pathname === "/console") {
    clientWss.handleUpgrade(req, socket, head, (ws) =>
      clientWss.emit("connection", ws, req, url.searchParams.get("ticket")),
    );
  } else {
    socket.destroy();
  }
});

/* ----------------------------- agent sockets ----------------------------- */

agentWss.on("connection", (ws: WebSocket) => {
  let conn: AgentConnection | null = null;

  const authTimer = setTimeout(() => {
    if (!conn) ws.close(4401, "hello timeout");
  }, 10_000);

  ws.on("message", async (raw) => {
    let msg: AgentMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return ws.close(4400, "bad json");
    }

    if (!conn) {
      if (msg.type !== "hello") return ws.close(4401, "hello required");
      if (msg.protocol !== PROTOCOL_VERSION) return ws.close(4426, "protocol mismatch");

      const node = await prisma.node.findUnique({ where: { id: msg.nodeId } });
      if (!node) return ws.close(4404, "unknown node");
      if (!(await bcrypt.compare(msg.token, node.agentTokenHash))) {
        console.warn(`[gateway] rejected agent for node ${msg.nodeId}: bad token`);
        return ws.close(4403, "bad token");
      }

      // A reconnect replaces any stale socket for the same node.
      agents.get(node.id)?.socket.close(4000, "replaced");

      conn = { nodeId: node.id, socket: ws, alive: true, version: msg.agentVersion };
      agents.set(node.id, conn);
      clearTimeout(authTimer);

      await prisma.node.update({
        where: { id: node.id },
        data: {
          status: "ONLINE",
          agentVersion: msg.agentVersion,
          lastHeartbeat: new Date(),
          // Trust the agent for hardware totals only if the admin left them at zero.
          totalCpuCores: node.totalCpuCores || msg.system.cpuCores,
          totalMemoryMb: node.totalMemoryMb || msg.system.totalMemoryMb,
          totalDiskMb: node.totalDiskMb || msg.system.totalDiskMb,
        },
      });
      await redis.set(`agent:online:${node.id}`, "1", "EX", ONLINE_TTL_SECONDS);
      await subscribeCommands(node.id);

      const expected = await prisma.server.findMany({
        where: { nodeId: node.id, status: { not: "DELETING" } },
        select: { id: true },
      });
      send(ws, {
        type: "hello.ack",
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        expectedServers: expected.map((s) => s.id),
      });
      console.log(`[gateway] node ${node.name} online (agent ${msg.agentVersion})`);
      return;
    }

    switch (msg.type) {
      case "heartbeat": {
        conn.alive = true;
        await redis.set(`agent:online:${conn.nodeId}`, "1", "EX", ONLINE_TTL_SECONDS);
        await prisma.node.update({
          where: { id: conn.nodeId },
          data: {
            lastHeartbeat: new Date(msg.at),
            status: "ONLINE",
            liveCpuPercent: msg.stats.cpuPercent,
            liveMemoryMb: msg.stats.memoryUsedMb,
            liveDiskMb: msg.stats.diskUsedMb,
          },
        });
        await redis.set(
          `node:telemetry:${conn.nodeId}`,
          JSON.stringify({ stats: msg.stats, containers: msg.containers, at: msg.at }),
          "EX",
          120,
        );
        break;
      }
      case "console": {
        const payload = JSON.stringify(msg);
        for (const viewer of consoleViewers.get(msg.serverId) ?? []) {
          if (viewer.readyState === WebSocket.OPEN) viewer.send(payload);
        }
        await redis.lpush(`console:buffer:${msg.serverId}`, payload);
        await redis.ltrim(`console:buffer:${msg.serverId}`, 0, 499);
        await redis.expire(`console:buffer:${msg.serverId}`, 3600);
        break;
      }
      case "state": {
        const status =
          msg.state === "running"
            ? "RUNNING"
            : msg.state === "restarting"
              ? "STARTING"
              : msg.exitCode && msg.exitCode !== 0
                ? "CRASHED"
                : "OFFLINE";
        await prisma.server
          .update({ where: { id: msg.serverId }, data: { status } })
          .catch(() => undefined);
        const payload = JSON.stringify({ type: "state", serverId: msg.serverId, status });
        for (const viewer of consoleViewers.get(msg.serverId) ?? []) {
          if (viewer.readyState === WebSocket.OPEN) viewer.send(payload);
        }
        break;
      }
      case "result": {
        await redis.publish(
          "agent:replies",
          JSON.stringify({ id: msg.id, ok: msg.ok, data: msg.data, error: msg.error }),
        );
        break;
      }
    }
  });

  ws.on("close", async () => {
    clearTimeout(authTimer);
    if (!conn) return;
    if (agents.get(conn.nodeId)?.socket === ws) {
      agents.delete(conn.nodeId);
      await redis.del(`agent:online:${conn.nodeId}`);
      await prisma.node
        .update({ where: { id: conn.nodeId }, data: { status: "OFFLINE" } })
        .catch(() => undefined);
      console.log(`[gateway] node ${conn.nodeId} offline`);
    }
  });

  ws.on("pong", () => {
    if (conn) conn.alive = true;
  });
});

/** One Redis subscription per node carries commands from any panel instance. */
const subscribedNodes = new Set<string>();
async function subscribeCommands(nodeId: string) {
  if (subscribedNodes.has(nodeId)) return;
  subscribedNodes.add(nodeId);
  await redisSub.subscribe(`agent:commands:${nodeId}`);
}

redisSub.on("message", (channel, raw) => {
  const nodeId = channel.replace("agent:commands:", "");
  const conn = agents.get(nodeId);
  if (!conn) return;
  try {
    const cmd = JSON.parse(raw) as ControlCommand;
    send(conn.socket, cmd);
  } catch {
    /* ignore malformed */
  }
});

/* ---------------------------- browser console ---------------------------- */

clientWss.on("connection", async (ws: WebSocket, _req, ticket: string | null) => {
  if (!ticket) return ws.close(4401, "ticket required");

  const raw = await redis.get(`console:ticket:${ticket}`);
  if (!raw) return ws.close(4401, "ticket expired");
  await redis.del(`console:ticket:${ticket}`); // single use

  const { serverId, nodeId, canCommand } = JSON.parse(raw) as {
    serverId: string;
    nodeId: string;
    canCommand: boolean;
  };

  let viewers = consoleViewers.get(serverId);
  if (!viewers) {
    viewers = new Set();
    consoleViewers.set(serverId, viewers);
    await redis.publish(
      `agent:commands:${nodeId}`,
      JSON.stringify({
        type: "command",
        id: `attach-${serverId}`,
        payload: { op: "console.attach", serverId, tailLines: 200 },
      }),
    );
  }
  viewers.add(ws);

  const history = await redis.lrange(`console:buffer:${serverId}`, 0, 199);
  for (const line of history.reverse()) ws.send(line);

  ws.on("message", async (data) => {
    if (!canCommand) return;
    let parsed: { type: string; command?: string };
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (parsed.type === "command" && typeof parsed.command === "string") {
      // Console input goes to the game process stdin only — never to a host shell.
      await redis.publish(
        `agent:commands:${nodeId}`,
        JSON.stringify({
          type: "command",
          id: `cmd-${Date.now()}`,
          payload: { op: "server.command", serverId, command: parsed.command.slice(0, 2000) },
        }),
      );
    }
  });

  ws.on("close", async () => {
    viewers?.delete(ws);
    if (viewers && viewers.size === 0) {
      consoleViewers.delete(serverId);
      await redis.publish(
        `agent:commands:${nodeId}`,
        JSON.stringify({
          type: "command",
          id: `detach-${serverId}`,
          payload: { op: "console.detach", serverId },
        }),
      );
    }
  });
});

/* ------------------------------ liveness ------------------------------ */

setInterval(() => {
  for (const conn of agents.values()) {
    if (!conn.alive) {
      conn.socket.terminate();
      continue;
    }
    conn.alive = false;
    conn.socket.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

/** Marks nodes offline whose agent died without a clean close. */
setInterval(async () => {
  const cutoff = new Date(Date.now() - 60_000);
  await prisma.node.updateMany({
    where: { status: "ONLINE", lastHeartbeat: { lt: cutoff } },
    data: { status: "UNREACHABLE" },
  });
}, 30_000);

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

server.listen(PORT, () => console.log(`[gateway] listening on :${PORT}`));
