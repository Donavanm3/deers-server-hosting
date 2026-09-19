import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { redis } from "./redis";

/**
 * Node scheduler.
 *
 * Correctness rule: a node's free capacity is derived only from `reserved_*`
 * columns, never from live telemetry. Telemetry is advisory — a server that is
 * currently stopped still owns its RAM.
 *
 * Race safety: candidate rows are locked with SELECT ... FOR UPDATE inside the
 * same transaction that writes the reservation, so two concurrent purchases
 * serialise on the node row instead of both reading the same free figure.
 */

export interface PlacementRequest {
  memoryMb: number;
  diskMb: number;
  cpuCores: number;
  templateId: string;
  /** Soft preference. If no node in this location fits, others are still considered. */
  preferredLocation?: string | null;
  /** Nodes to skip, e.g. one that already failed this provisioning attempt. */
  excludeNodeIds?: string[];
}

export interface Reservation {
  nodeId: string;
  nodeName: string;
  memoryMb: number;
  diskMb: number;
  cpuCores: number;
}

export class NoCapacityError extends Error {
  constructor(public request: PlacementRequest) {
    super("No node has enough available capacity for this plan.");
    this.name = "NoCapacityError";
  }
}

interface CandidateRow {
  id: string;
  name: string;
  location: string;
  free_memory: number;
  free_disk: number;
  free_cpu: number;
  total_memory: number;
  total_disk: number;
  total_cpu: number;
}

/**
 * Heartbeat freshness window. A node whose agent has not checked in recently is
 * not a scheduling target even if the DB still says ONLINE.
 */
const HEARTBEAT_STALE_MS = 60_000;

function balanceScore(row: CandidateRow, req: PlacementRequest): number {
  // After placing, how evenly loaded is the node? Lower spread is better, which
  // keeps one dimension (usually RAM) from being exhausted while disk sits idle.
  const memAfter = 1 - (row.free_memory - req.memoryMb) / row.total_memory;
  const diskAfter = 1 - (row.free_disk - req.diskMb) / row.total_disk;
  const cpuAfter = 1 - (row.free_cpu - req.cpuCores) / row.total_cpu;

  const mean = (memAfter + diskAfter + cpuAfter) / 3;
  const spread =
    Math.abs(memAfter - mean) + Math.abs(diskAfter - mean) + Math.abs(cpuAfter - mean);

  // Prefer the least-loaded node overall, then the most balanced one.
  return mean * 2 + spread;
}

/**
 * Reserves capacity for a server and runs `onReserved` inside the same transaction.
 * If `onReserved` throws, the reservation is rolled back with it — there is no
 * window where capacity is held by a server that was never written.
 */
export async function reserveCapacity<T>(
  req: PlacementRequest,
  onReserved: (
    tx: Prisma.TransactionClient,
    reservation: Reservation,
  ) => Promise<T>,
): Promise<{ reservation: Reservation; result: T }> {
  const staleBefore = new Date(Date.now() - HEARTBEAT_STALE_MS);
  const exclude = req.excludeNodeIds ?? [];

  return prisma.$transaction(
    async (tx) => {
      // 1-4. Online, enabled, template-capable, capacity-bearing nodes — locked.
      //      FOR UPDATE makes concurrent schedulers queue on the same rows.
      const candidates = await tx.$queryRaw<CandidateRow[]>`
        SELECT
          n.id,
          n.name,
          n.location,
          (n."totalMemoryMb" - n."reservedMemoryMb" - n."overheadMemoryMb") AS free_memory,
          (n."totalDiskMb"   - n."reservedDiskMb"   - n."overheadDiskMb")   AS free_disk,
          (n."totalCpuCores" - n."reservedCpuCores")                        AS free_cpu,
          n."totalMemoryMb" AS total_memory,
          n."totalDiskMb"   AS total_disk,
          n."totalCpuCores" AS total_cpu
        FROM "Node" n
        JOIN "NodeTemplate" nt ON nt."nodeId" = n.id
        WHERE n.status = 'ONLINE'
          AND n.enabled = TRUE
          AND nt."templateId" = ${req.templateId}
          AND n."lastHeartbeat" IS NOT NULL
          AND n."lastHeartbeat" > ${staleBefore}
          AND NOT (n.id = ANY(${exclude}::text[]))
          AND (n."totalMemoryMb" - n."reservedMemoryMb" - n."overheadMemoryMb") >= ${req.memoryMb}
          AND (n."totalDiskMb"   - n."reservedDiskMb"   - n."overheadDiskMb")   >= ${req.diskMb}
          AND (n."totalCpuCores" - n."reservedCpuCores")                        >= ${req.cpuCores}
        ORDER BY n.id
        FOR UPDATE OF n
      `;

      if (candidates.length === 0) throw new NoCapacityError(req);

      // 5. Location preference first, then best resource balance.
      const preferred = req.preferredLocation
        ? candidates.filter((c) => c.location === req.preferredLocation)
        : [];
      const pool = preferred.length > 0 ? preferred : candidates;
      const chosen = pool.reduce((best, row) =>
        balanceScore(row, req) < balanceScore(best, req) ? row : best,
      );

      // 6. Reserve atomically. The WHERE clause re-checks capacity so that even a
      //    hand-written concurrent UPDATE cannot push the node negative.
      const updated = await tx.$executeRaw`
        UPDATE "Node"
        SET "reservedMemoryMb" = "reservedMemoryMb" + ${req.memoryMb},
            "reservedDiskMb"   = "reservedDiskMb"   + ${req.diskMb},
            "reservedCpuCores" = "reservedCpuCores" + ${req.cpuCores}
        WHERE id = ${chosen.id}
          AND ("totalMemoryMb" - "reservedMemoryMb" - "overheadMemoryMb") >= ${req.memoryMb}
          AND ("totalDiskMb"   - "reservedDiskMb"   - "overheadDiskMb")   >= ${req.diskMb}
          AND ("totalCpuCores" - "reservedCpuCores")                      >= ${req.cpuCores}
      `;
      if (updated !== 1) throw new NoCapacityError(req);

      const reservation: Reservation = {
        nodeId: chosen.id,
        nodeName: chosen.name,
        memoryMb: req.memoryMb,
        diskMb: req.diskMb,
        cpuCores: req.cpuCores,
      };

      // 7. Caller writes the Server row here, still inside the lock.
      const result = await onReserved(tx, reservation);
      return { reservation, result };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 15_000,
      maxWait: 10_000,
    },
  );
}

/**
 * Releases a reservation. Called when container creation fails after the
 * transaction committed, and on server deletion.
 */
export async function releaseCapacity(
  nodeId: string,
  amount: { memoryMb: number; diskMb: number; cpuCores: number },
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  // GREATEST(...) guards against drift making a counter negative.
  await tx.$executeRaw`
    UPDATE "Node"
    SET "reservedMemoryMb" = GREATEST(0, "reservedMemoryMb" - ${amount.memoryMb}),
        "reservedDiskMb"   = GREATEST(0, "reservedDiskMb"   - ${amount.diskMb}),
        "reservedCpuCores" = GREATEST(0, "reservedCpuCores" - ${amount.cpuCores})
    WHERE id = ${nodeId}
  `;
}

/**
 * Claims a free port on the node inside the caller's transaction.
 * Unique(nodeId, ip, port) plus the FOR UPDATE lock prevents double assignment.
 */
export async function claimAllocation(
  tx: Prisma.TransactionClient,
  nodeId: string,
  serverId: string,
): Promise<{ id: string; ip: string; port: number }> {
  const rows = await tx.$queryRaw<{ id: string; ip: string; port: number }[]>`
    SELECT id, ip, port FROM "Allocation"
    WHERE "nodeId" = ${nodeId} AND "serverId" IS NULL
    ORDER BY port
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `;
  if (rows.length === 0) {
    throw new Error(`Node ${nodeId} has no free network allocation.`);
  }
  const alloc = rows[0];
  await tx.allocation.update({
    where: { id: alloc.id },
    data: { serverId, primary: true },
  });
  return alloc;
}

/**
 * Recomputes reserved_* from the servers actually placed on a node.
 * Run by the reconciler; also exposed to admins as "Recalculate resources".
 */
export async function recalculateNodeReservations(nodeId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Node" n
    SET "reservedMemoryMb" = COALESCE(s.mem, 0),
        "reservedDiskMb"   = COALESCE(s.disk, 0),
        "reservedCpuCores" = COALESCE(s.cpu, 0)
    FROM (
      SELECT SUM("memoryMb")::int AS mem,
             SUM("diskMb")::int   AS disk,
             SUM("cpuCores")      AS cpu
      FROM "Server"
      WHERE "nodeId" = ${nodeId} AND status <> 'DELETING'
    ) s
    WHERE n.id = ${nodeId}
  `;
  await redis.del(`node:capacity:${nodeId}`);
}
