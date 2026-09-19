import { randomUUID } from "node:crypto";
import type { CommandPayload } from "@deers/shared/protocol";
import { redis, redisSubscriber } from "./redis";

/**
 * The panel never talks to an agent directly — agents hold a socket to the gateway.
 * Commands travel panel -> Redis -> gateway -> agent, replies come back the same way.
 * That keeps the panel horizontally scalable and stateless.
 */

const REPLY_CHANNEL = "agent:replies";
const pending = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
>();

let subscribed = false;

async function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  await redisSubscriber.subscribe(REPLY_CHANNEL);
  redisSubscriber.on("message", (channel, raw) => {
    if (channel !== REPLY_CHANNEL) return;
    let msg: { id: string; ok: boolean; data?: unknown; error?: { message: string; code: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return; // reply for another panel instance
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.data);
    else entry.reject(new AgentError(msg.error?.code ?? "agent_error", msg.error?.message ?? "Agent call failed"));
  });
}

export class AgentError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "AgentError";
  }
}

export class NodeOfflineError extends AgentError {
  constructor(nodeId: string) {
    super("node_offline", `Node ${nodeId} has no connected agent.`);
  }
}

export async function isNodeConnected(nodeId: string): Promise<boolean> {
  return (await redis.exists(`agent:online:${nodeId}`)) === 1;
}

export async function callAgent<T = unknown>(
  nodeId: string,
  payload: CommandPayload,
  timeoutMs = 20_000,
): Promise<T> {
  await ensureSubscribed();
  if (!(await isNodeConnected(nodeId))) throw new NodeOfflineError(nodeId);

  const id = randomUUID();
  const promise = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new AgentError("timeout", `Agent on node ${nodeId} did not answer in ${timeoutMs}ms.`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
  });

  const delivered = await redis.publish(
    `agent:commands:${nodeId}`,
    JSON.stringify({ type: "command", id, payload }),
  );
  if (delivered === 0) {
    const entry = pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(id);
    }
    throw new NodeOfflineError(nodeId);
  }

  return promise;
}

/** Fire-and-forget: used for console input where a round trip adds nothing. */
export async function notifyAgent(nodeId: string, payload: CommandPayload): Promise<void> {
  await redis.publish(
    `agent:commands:${nodeId}`,
    JSON.stringify({ type: "command", id: randomUUID(), payload }),
  );
}
