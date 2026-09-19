import { prisma } from "./db";
import { redis } from "./redis";
import type { ContainerSummary } from "@deers/shared/protocol";

/**
 * Telemetry retention. Heartbeats land in Redis with a short TTL for the live
 * view; the worker samples them into Postgres once a minute, then compacts
 * minutes into hours after 48 hours so the table stays small.
 */

const MINUTE_RETENTION_HOURS = 48;
const HOUR_RETENTION_DAYS = 90;

interface Telemetry {
  stats: { cpuPercent: number; memoryUsedMb: number; diskUsedMb: number };
  containers: ContainerSummary[];
  at: number;
}

export async function sampleMetrics() {
  const nodes = await prisma.node.findMany({
    where: { status: "ONLINE" },
    select: { id: true },
  });

  const bucket = new Date();
  bucket.setUTCSeconds(0, 0);
  let written = 0;

  for (const node of nodes) {
    const raw = await redis.get(`node:telemetry:${node.id}`);
    if (!raw) continue;
    const telemetry = JSON.parse(raw) as Telemetry;

    for (const container of telemetry.containers) {
      await prisma.serverMetric
        .upsert({
          where: {
            serverId_bucket_resolution: {
              serverId: container.serverId,
              bucket,
              resolution: "minute",
            },
          },
          create: {
            serverId: container.serverId,
            bucket,
            resolution: "minute",
            cpuPercent: container.cpuPercent,
            memoryMb: container.memoryUsedMb,
            diskMb: container.diskUsedMb,
          },
          update: {},
        })
        .then(() => written++)
        .catch(() => undefined); // server deleted mid-sample
    }
  }
  return { written };
}

export async function compactMetrics() {
  const minuteCutoff = new Date(Date.now() - MINUTE_RETENTION_HOURS * 3_600_000);

  // Average each hour's minutes into one row, then drop the minutes.
  await prisma.$executeRaw`
    INSERT INTO "ServerMetric" ("serverId", bucket, resolution, "cpuPercent", "memoryMb", "diskMb", samples)
    SELECT "serverId",
           date_trunc('hour', bucket) AS bucket,
           'hour',
           AVG("cpuPercent"),
           AVG("memoryMb")::int,
           MAX("diskMb"),
           COUNT(*)::int
    FROM "ServerMetric"
    WHERE resolution = 'minute' AND bucket < ${minuteCutoff}
    GROUP BY "serverId", date_trunc('hour', bucket)
    ON CONFLICT ("serverId", bucket, resolution) DO NOTHING
  `;

  const deletedMinutes = await prisma.serverMetric.deleteMany({
    where: { resolution: "minute", bucket: { lt: minuteCutoff } },
  });
  const deletedHours = await prisma.serverMetric.deleteMany({
    where: {
      resolution: "hour",
      bucket: { lt: new Date(Date.now() - HOUR_RETENTION_DAYS * 86_400_000) },
    },
  });

  return { compactedFrom: deletedMinutes.count, expiredHours: deletedHours.count };
}

export async function serverHistory(serverId: string, hours = 24) {
  const since = new Date(Date.now() - hours * 3_600_000);
  return prisma.serverMetric.findMany({
    where: { serverId, bucket: { gte: since } },
    orderBy: { bucket: "asc" },
    select: { bucket: true, cpuPercent: true, memoryMb: true, diskMb: true, resolution: true },
  });
}
