import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Agent self-update.
 *
 * The control plane offers a version, a URL and a SHA-256. The agent decides
 * whether to take it: the hash must match before the binary is swapped, and the
 * old binary is kept so a bad build can be rolled back by systemd's restart.
 *
 * Game servers are containers and are not touched — the agent restarting is
 * invisible to players.
 */
const INSTALL_PATH = process.env.DEERS_AGENT_PATH ?? "/opt/deers-agent/agent.cjs";

export interface UpdateOffer {
  version: string;
  url: string;
  sha256: string;
}

export async function applyUpdate(offer: UpdateOffer, currentVersion: string) {
  if (offer.version === currentVersion) return { applied: false, reason: "already current" };

  console.log(`[agent] update offered: ${currentVersion} -> ${offer.version}`);

  const res = await fetch(offer.url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Update download failed with HTTP ${res.status}`);
  const payload = Buffer.from(await res.arrayBuffer());

  // Verify before anything touches the filesystem. A mismatch means the download
  // was corrupted or tampered with, and is never installed.
  const digest = createHash("sha256").update(payload).digest("hex");
  if (digest !== offer.sha256) {
    throw new Error(`Update checksum mismatch: expected ${offer.sha256}, got ${digest}`);
  }

  const staged = `${INSTALL_PATH}.new`;
  const previous = `${INSTALL_PATH}.previous`;

  await fs.writeFile(staged, payload, { mode: 0o755 });
  await fs.copyFile(INSTALL_PATH, previous).catch(() => undefined);
  await fs.rename(staged, INSTALL_PATH);

  console.log(`[agent] updated to ${offer.version}; restarting`);

  // systemd (Restart=always) brings the new binary up. Exiting cleanly here is
  // the whole restart mechanism — no self-exec, no orphaned process.
  setTimeout(() => process.exit(0), 250);

  await exec("systemctl", ["restart", "deers-agent"]).catch(() => undefined);
  return { applied: true, version: offer.version };
}

export async function rollback() {
  const previous = `${INSTALL_PATH}.previous`;
  if (!(await fs.access(previous).then(() => true).catch(() => false))) {
    throw new Error("No previous agent binary to roll back to.");
  }
  await fs.copyFile(previous, INSTALL_PATH);
  console.warn(`[agent] rolled back to ${path.basename(previous)}; restarting`);
  setTimeout(() => process.exit(0), 250);
}
