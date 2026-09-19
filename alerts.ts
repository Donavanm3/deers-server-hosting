import { prisma } from "./db";

/**
 * Operational alerting.
 *
 * Alerts are keyed and deduplicated, so a node down for an hour is one open
 * alert rather than sixty notifications. An alert that stops being true resolves
 * itself on the next pass, which keeps the open list a live picture of the fleet
 * rather than a log to scroll through.
 */

type Severity = "INFO" | "WARNING" | "CRITICAL";

export async function raiseAlert(params: {
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  targetType: string;
  targetId: string;
}) {
  const existing = await prisma.alert.findUnique({ where: { key: params.key } });

  // Already open: nothing to do, and crucially no second notification.
  if (existing && !existing.resolvedAt) return existing;

  const alert = await prisma.alert.upsert({
    where: { key: params.key },
    create: { ...params },
    update: { ...params, resolvedAt: null, notifiedAt: null, createdAt: new Date() },
  });

  await notify(alert).catch((err) => console.error(`[alerts] notify failed for ${alert.key}:`, err));
  return alert;
}

export async function resolveAlert(key: string) {
  const existing = await prisma.alert.findUnique({ where: { key } });
  if (!existing || existing.resolvedAt) return;
  await prisma.alert.update({ where: { key }, data: { resolvedAt: new Date() } });
}

async function notify(alert: {
  id: string;
  key: string;
  severity: string;
  title: string;
  detail: string;
}) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return; // alerts are still recorded and visible in the panel

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: `[${alert.severity}] ${alert.title}\n${alert.detail}`,
      key: alert.key,
      severity: alert.severity,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (res.ok) {
    await prisma.alert.update({ where: { id: alert.id }, data: { notifiedAt: new Date() } });
  }
}

/**
 * Fleet health pass, run by the worker every few minutes. Each check both raises
 * and resolves, so recovery clears the alert without anyone clicking anything.
 */
export async function evaluateAlerts() {
  const raised: string[] = [];

  const nodes = await prisma.node.findMany({ include: { _count: { select: { servers: true } } } });

  for (const node of nodes) {
    // 1. Nodes that should be reporting and are not.
    const downKey = `node.down.${node.id}`;
    if (node.status !== "ONLINE") {
      await raiseAlert({
        key: downKey,
        severity: node._count.servers > 0 ? "CRITICAL" : "WARNING",
        title: `Node ${node.name} is ${node.status.toLowerCase()}`,
        detail: `${node._count.servers} server(s) affected. Last heartbeat ${
          node.lastHeartbeat?.toISOString() ?? "never"
        }.`,
        targetType: "node",
        targetId: node.id,
      });
      raised.push(downKey);
    } else {
      await resolveAlert(downKey);
    }

    // 2. Nodes running out of sellable capacity, while they can still be topped up.
    const freeMemory = node.totalMemoryMb - node.reservedMemoryMb - node.overheadMemoryMb;
    const freeRatio = node.totalMemoryMb > 0 ? freeMemory / node.totalMemoryMb : 1;
    const capacityKey = `node.capacity.${node.id}`;
    if (node.enabled && freeRatio < 0.1) {
      await raiseAlert({
        key: capacityKey,
        severity: "WARNING",
        title: `Node ${node.name} is nearly full`,
        detail: `${Math.round(freeMemory / 1024)} GB of memory left to sell.`,
        targetType: "node",
        targetId: node.id,
      });
      raised.push(capacityKey);
    } else {
      await resolveAlert(capacityKey);
    }
  }

  // 3. Crash loops. Invisible to the customer until they try to play, so support
  //    should hear about it first.
  const crashed = await prisma.server.findMany({
    where: { status: "CRASHED", suspended: false },
    select: { id: true, name: true },
  });
  for (const server of crashed) {
    const key = `server.crashed.${server.id}`;
    await raiseAlert({
      key,
      severity: "WARNING",
      title: `${server.name} has crashed`,
      detail: "The container exited with a non-zero status and has not restarted.",
      targetType: "server",
      targetId: server.id,
    });
    raised.push(key);
  }

  // 4. Archives that would die with their node despite an object store existing.
  const fragile = await prisma.backup.count({ where: { location: "NODE", completed: true } });
  const fragileKey = "backups.node_only";
  if (fragile > 0 && process.env.DEERS_S3_BUCKET) {
    await raiseAlert({
      key: fragileKey,
      severity: "INFO",
      title: `${fragile} backup(s) are still node-local`,
      detail: "An object store is configured, but these archives predate it and would be lost with the node.",
      targetType: "system",
      targetId: "backups",
    });
    raised.push(fragileKey);
  } else {
    await resolveAlert(fragileKey);
  }

  // Crash alerts this pass did not re-raise have recovered.
  const open = await prisma.alert.findMany({ where: { resolvedAt: null } });
  for (const alert of open) {
    if (alert.key.startsWith("server.crashed.") && !raised.includes(alert.key)) {
      await resolveAlert(alert.key);
    }
  }

  return { open: raised.length };
}
