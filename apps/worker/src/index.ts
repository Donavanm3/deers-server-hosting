import Redis from "ioredis";
import { runBillingCycle } from "../../panel/src/lib/billing";
import { runScheduledBackups } from "../../panel/src/lib/backups";
import { sampleMetrics, compactMetrics } from "../../panel/src/lib/metrics";
import { evaluateAlerts } from "../../panel/src/lib/alerts";
import { reconcileFleet } from "./reconciler";

/**
 * Background worker. Single-purpose and restartable: every pass is idempotent,
 * so a crash mid-cycle costs at most one iteration.
 *
 * A Redis lock means you can run several worker replicas for availability
 * without two of them billing the same customer twice.
 */

const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
const WORKER_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

async function withLock(name: string, ttlSeconds: number, fn: () => Promise<unknown>) {
  const key = `worker:lock:${name}`;
  const acquired = await redis.set(key, WORKER_ID, "EX", ttlSeconds, "NX");
  if (!acquired) return;
  try {
    const result = await fn();
    if (result) console.log(`[worker] ${name}`, result);
  } catch (err) {
    console.error(`[worker] ${name} failed:`, err);
  } finally {
    // Only release our own lock — a slow pass must not free a successor's.
    const holder = await redis.get(key);
    if (holder === WORKER_ID) await redis.del(key);
  }
}

function every(ms: number, fn: () => Promise<void>) {
  const tick = () => void fn().catch((err) => console.error("[worker] tick failed:", err));
  tick();
  return setInterval(tick, ms);
}

every(60_000, () => withLock("metrics.sample", 55, sampleMetrics));
every(60_000, () => withLock("backups.scheduled", 300, runScheduledBackups));
every(5 * 60_000, () => withLock("fleet.reconcile", 240, reconcileFleet));
every(3 * 60_000, () => withLock("alerts.evaluate", 150, evaluateAlerts));
every(60 * 60_000, () => withLock("metrics.compact", 3000, compactMetrics));
every(60 * 60_000, () => withLock("billing.cycle", 3000, runBillingCycle));

console.log(`[worker] started as ${WORKER_ID}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log("[worker] shutting down");
    void redis.quit().finally(() => process.exit(0));
  });
}
