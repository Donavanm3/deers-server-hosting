import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";
import type { ContainerSummary } from "@deers/shared/protocol";
import { recalculateNodeReservations } from "../../panel/src/lib/scheduler";
import { raise, resolve } from "../../panel/src/lib/alerts";

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");

/**
 * Keeps the database honest about the fleet.
 *
 * Three kinds of drift are worth catching: a node marked ONLINE whose agent has
 * gone quiet, a server whose recorded status disagrees with the container, and
 * reserved counters that have slipped out of step with the servers actually placed.
 */
export async function reconcileFleet() {
  const summary = { nodesMarkedDown: 0, statusesCorrected: 0, nodesRecalculated: 0 };
  const nodes = await prisma.node.findMany({ select: { id: true, status: true } });

  for (const node of nodes) {
    const raw = await redis.get(`node:telemetry:${node.id}`);

    if (!raw) {
      if (node.status === "ONLINE") {
        await prisma.node.update({ where: { id: node.id }, data: { status: "UNREACHABLE" } });
        summary.nodesMarkedDown++;
      }
      const placed = await prisma.server.count({ where: { nodeId: node.id } });
      await raise({
        key: `node.down.${node.id}`,
        severity: placed > 0 ? "critical" : "warning",
        title: "Node is not reporting",
        detail: `No heartbeat from node ${node.id}. ${placed} server(s) affected.`,
        context: { nodeId: node.id, servers: placed },
      });
      continue;
    }

    await resolve(`node.down.${node.id}`);

    const telemetry = JSON.parse(raw) as { containers: ContainerSummary[] };
    const byId = new Map(telemetry.containers.map((c) => [c.serverId, c]));
    const servers = await prisma.server.findMany({
      where: { nodeId: node.id },
      select: { id: true, status: true, suspended: true },
    });

    for (const server of servers) {
      const container = byId.get(server.id);
      const actual = !container
        ? "OFFLINE"
        : container.state === "running"
          ? "RUNNING"
          : container.state === "restarting"
            ? "STARTING"
            : "OFFLINE";

      // Transitional states are left alone; they resolve on their own and
      // overwriting them would fight the operation in progress.
      const transitional = ["PROVISIONING", "INSTALLING", "STARTING", "STOPPING", "DELETING"];
      if (transitional.includes(server.status)) continue;
      if (server.suspended) continue;

      if (server.status !== actual) {
        await prisma.server.update({ where: { id: server.id }, data: { status: actual } });
        summary.statusesCorrected++;
      }
    }

    // Cheap integrity check on the numbers the scheduler sells against.
    const placed = await prisma.server.aggregate({
      where: { nodeId: node.id, status: { not: "DELETING" } },
      _sum: { memoryMb: true, diskMb: true, cpuCores: true },
    });
    const current = await prisma.node.findUniqueOrThrow({
      where: { id: node.id },
      select: { reservedMemoryMb: true, reservedDiskMb: true, reservedCpuCores: true },
    });
    if (
      current.reservedMemoryMb !== (placed._sum.memoryMb ?? 0) ||
      current.reservedDiskMb !== (placed._sum.diskMb ?? 0) ||
      current.reservedCpuCores !== (placed._sum.cpuCores ?? 0)
    ) {
      await raise({
        key: `node.drift.${node.id}`,
        severity: "warning",
        title: "Reservation drift corrected",
        detail: `Reserved totals on node ${node.id} disagreed with placed servers and were recalculated.`,
        context: {
          nodeId: node.id,
          recordedMemoryMb: current.reservedMemoryMb,
          actualMemoryMb: placed._sum.memoryMb ?? 0,
        },
      });
      await recalculateNodeReservations(node.id);
      summary.nodesRecalculated++;
    }
  }

  await checkFleetCapacity();
  return summary;
}

/**
 * Warns before the fleet runs out of sellable room, because adding a node takes
 * longer than selling the last plan on the current ones.
 */
async function checkFleetCapacity() {
  const nodes = await prisma.node.findMany({
    where: { status: "ONLINE", enabled: true },
    select: {
      id: true,
      name: true,
      totalMemoryMb: true,
      reservedMemoryMb: true,
      overheadMemoryMb: true,
    },
  });

  const freeMb = nodes.reduce(
    (sum, n) => sum + Math.max(0, n.totalMemoryMb - n.reservedMemoryMb - n.overheadMemoryMb),
    0,
  );
  const threshold = Number(process.env.ALERT_LOW_CAPACITY_GB ?? 16) * 1024;

  if (freeMb < threshold) {
    await raise({
      key: "fleet.capacity.low",
      severity: freeMb < threshold / 4 ? "critical" : "warning",
      title: "Fleet capacity is low",
      detail: `${(freeMb / 1024).toFixed(1)} GB of sellable memory left across ${nodes.length} node(s).`,
      context: { freeMb, nodes: nodes.length },
    });
  } else {
    await resolve("fleet.capacity.low");
  }
}
