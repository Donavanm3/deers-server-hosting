import { prisma } from "./db";
import { callAgent } from "./agent-rpc";
import { audit } from "./audit";

/**
 * Backups live on the node that holds the server, written by the agent. The
 * control plane only records metadata, which keeps large archives off the panel
 * and makes off-node storage a later swap inside the provider.
 */

export class BackupQuotaError extends Error {
  constructor(usedMb: number, limitMb: number) {
    super(`Backup storage is full: ${usedMb} MB of ${limitMb} MB used.`);
    this.name = "BackupQuotaError";
  }
}

export async function createBackup(serverId: string, name: string, actorId?: string | null) {
  const server = await prisma.server.findUniqueOrThrow({
    where: { id: serverId },
    include: { plan: true, backups: true },
  });

  const usedMb = Math.round(
    server.backups.reduce((sum, b) => sum + Number(b.bytes), 0) / 1024 / 1024,
  );
  if (server.plan.backupMb > 0 && usedMb >= server.plan.backupMb) {
    throw new BackupQuotaError(usedMb, server.plan.backupMb);
  }

  // The row is written first so a backup that fails mid-archive is visible as
  // incomplete rather than vanishing.
  const backup = await prisma.backup.create({
    data: { serverId, name, completed: false },
  });

  try {
    const result = await callAgent<{ bytes: number; checksum: string; objectKey?: string }>(
      server.nodeId,
      { op: "backup.create", serverId, backupId: backup.id },
      15 * 60_000,
    );
    const done = await prisma.backup.update({
      where: { id: backup.id },
      data: {
        bytes: BigInt(result.bytes),
        checksum: result.checksum,
        completed: true,
        // An archive in the object store survives the node; one on the node does not.
        location: result.objectKey ? "OBJECT_STORE" : "NODE",
        objectKey: result.objectKey ?? null,
      },
    });
    await audit({
      actorId,
      action: "backup.create",
      targetType: "server",
      targetId: serverId,
      metadata: { backupId: backup.id, bytes: result.bytes },
    });
    return done;
  } catch (err) {
    await prisma.backup.delete({ where: { id: backup.id } }).catch(() => undefined);
    throw err;
  }
}

/** Restoring overwrites the live volume, so the server is stopped first. */
export async function restoreBackup(serverId: string, backupId: string, actorId?: string | null) {
  const server = await prisma.server.findUniqueOrThrow({
    where: { id: serverId },
    include: { template: true },
  });
  const backup = await prisma.backup.findUniqueOrThrow({ where: { id: backupId } });
  if (backup.serverId !== serverId) throw new Error("That backup belongs to another server.");
  if (!backup.completed) throw new Error("That backup did not finish and cannot be restored.");

  await callAgent(server.nodeId, {
    op: "server.stop",
    serverId,
    stopCommand: server.template.stopCommand,
    timeoutSeconds: 60,
  });
  await callAgent(server.nodeId, { op: "backup.restore", serverId, backupId }, 15 * 60_000);

  await audit({
    actorId,
    action: "backup.restore",
    targetType: "server",
    targetId: serverId,
    metadata: { backupId },
  });
}

export async function deleteBackup(serverId: string, backupId: string, actorId?: string | null) {
  const server = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
  await callAgent(server.nodeId, { op: "backup.delete", serverId, backupId });
  await prisma.backup.delete({ where: { id: backupId } });
  await audit({
    actorId,
    action: "backup.delete",
    targetType: "server",
    targetId: serverId,
    metadata: { backupId },
  });
}

/**
 * Worker pass for scheduled backups. Runs every minute; a schedule fires when
 * the current UTC minute matches and today's weekday bit is set.
 */
export async function runScheduledBackups() {
  const now = new Date();
  const minuteUtc = now.getUTCHours() * 60 + now.getUTCMinutes();
  const dayBit = 1 << now.getUTCDay();

  const schedules = await prisma.backupSchedule.findMany({
    where: { enabled: true, minuteUtc },
    include: { server: { select: { id: true, suspended: true, name: true } } },
  });

  let run = 0;
  for (const schedule of schedules) {
    if ((schedule.daysMask & dayBit) === 0) continue;
    if (schedule.server.suspended) continue;
    // Guard against a worker restart re-firing the same minute.
    if (schedule.lastRunAt && now.getTime() - schedule.lastRunAt.getTime() < 90_000) continue;

    try {
      await createBackup(schedule.serverId, `Scheduled ${now.toISOString().slice(0, 16)}`);
      await pruneBackups(schedule.serverId, schedule.keepCount);
      run++;
    } catch (err) {
      console.error(`[backups] scheduled backup failed for ${schedule.serverId}:`, err);
    } finally {
      await prisma.backupSchedule.update({
        where: { id: schedule.id },
        data: { lastRunAt: now },
      });
    }
  }
  return { run };
}

/** Keeps the newest `keep` backups and deletes the rest, oldest first. */
export async function pruneBackups(serverId: string, keep: number) {
  const backups = await prisma.backup.findMany({
    where: { serverId, completed: true },
    orderBy: { createdAt: "desc" },
  });
  for (const stale of backups.slice(keep)) {
    await deleteBackup(serverId, stale.id).catch((err) =>
      console.error(`[backups] prune failed for ${stale.id}:`, err),
    );
  }
}
