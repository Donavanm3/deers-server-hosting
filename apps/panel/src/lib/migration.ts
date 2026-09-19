import { prisma } from "./db";
import { callAgent } from "./agent-rpc";
import { audit } from "./audit";
import { claimAllocation, releaseCapacity, reserveCapacity } from "./scheduler";

/**
 * Moves a server to another node — for draining a box before maintenance, or
 * relocating a customer closer to their players.
 *
 * Capacity on the target is reserved before anything is copied, and the source
 * reservation is only released after the target container starts. At no point
 * does the server exist on neither node's books.
 */
export async function migrateServer(
  serverId: string,
  targetNodeId: string | null,
  actorId?: string | null,
) {
  const server = await prisma.server.findUniqueOrThrow({
    where: { id: serverId },
    include: { template: true, node: true },
  });

  const job = await prisma.migrationJob.create({
    data: {
      serverId,
      fromNodeId: server.nodeId,
      toNodeId: targetNodeId ?? server.nodeId,
      status: "QUEUED",
    },
  });

  const setStatus = (status: Parameters<typeof prisma.migrationJob.update>[0]["data"]["status"]) =>
    prisma.migrationJob.update({ where: { id: job.id }, data: { status } });

  try {
    // 1. Reserve on the target. An explicit target still goes through the
    //    scheduler so the same capacity checks and row locks apply.
    const { reservation } = await reserveCapacity(
      {
        memoryMb: server.memoryMb,
        diskMb: server.diskMb,
        cpuCores: server.cpuCores,
        templateId: server.templateId,
        preferredLocation: targetNodeId ? null : server.node.location,
        excludeNodeIds: [server.nodeId],
      },
      async (tx, res) => {
        if (targetNodeId && res.nodeId !== targetNodeId) {
          throw new Error("The requested node does not have enough free capacity.");
        }
        await tx.migrationJob.update({ where: { id: job.id }, data: { toNodeId: res.nodeId } });
        return res;
      },
    );

    // 2. Stop and archive on the source.
    await setStatus("BACKING_UP");
    await callAgent(server.nodeId, {
      op: "server.stop",
      serverId,
      stopCommand: server.template.stopCommand,
      timeoutSeconds: 120,
    });
    const backup = await prisma.backup.create({
      data: { serverId, name: `Migration ${job.id.slice(0, 8)}`, completed: false },
    });
    const archive = await callAgent<{ bytes: number; checksum: string }>(
      server.nodeId,
      { op: "backup.create", serverId, backupId: backup.id },
      30 * 60_000,
    );
    await prisma.backup.update({
      where: { id: backup.id },
      data: { bytes: BigInt(archive.bytes), checksum: archive.checksum, completed: true },
    });

    // 3. Build the container on the target and restore into it.
    await setStatus("TRANSFERRING");
    const allocation = await prisma.$transaction((tx) =>
      claimAllocation(tx, reservation.nodeId, serverId),
    );

    await callAgent(
      reservation.nodeId,
      {
        op: "server.create",
        spec: {
          serverId,
          shortId: server.shortId,
          image: server.template.dockerImage,
          startCommand: server.template.startCommand,
          stopCommand: server.template.stopCommand,
          environment: {
            ...(server.environment as Record<string, string>),
            SERVER_PORT: String(allocation.port),
            SERVER_MEMORY: String(server.memoryMb),
          },
          memoryMb: server.memoryMb,
          diskMb: server.diskMb,
          cpuCores: server.cpuCores,
          ports: [
            { ip: allocation.ip, port: allocation.port, protocol: "tcp" },
            { ip: allocation.ip, port: allocation.port, protocol: "udp" },
          ],
        },
      },
      5 * 60_000,
    );

    await setStatus("RESTORING");
    await callAgent(
      reservation.nodeId,
      { op: "backup.restore", serverId, backupId: backup.id },
      30 * 60_000,
    );

    // 4. Switch the record over, then tear down the source.
    await setStatus("SWITCHING");
    await prisma.$transaction(async (tx) => {
      await tx.allocation.updateMany({
        where: { serverId, nodeId: server.nodeId },
        data: { serverId: null, primary: false },
      });
      await tx.server.update({
        where: { id: serverId },
        data: { nodeId: reservation.nodeId, status: "OFFLINE", containerId: null },
      });
      await releaseCapacity(
        server.nodeId,
        { memoryMb: server.memoryMb, diskMb: server.diskMb, cpuCores: server.cpuCores },
        tx,
      );
    });

    await callAgent(server.nodeId, { op: "server.delete", serverId, wipeVolume: true }).catch(
      (err) => console.error(`[migration] source cleanup failed on ${server.nodeId}:`, err),
    );

    await prisma.migrationJob.update({
      where: { id: job.id },
      data: { status: "COMPLETED", finishedAt: new Date(), backupId: backup.id },
    });
    await audit({
      actorId,
      action: "server.migrate",
      targetType: "server",
      targetId: serverId,
      metadata: { from: server.nodeId, to: reservation.nodeId },
    });

    return { jobId: job.id, nodeId: reservation.nodeId };
  } catch (err) {
    // The source is still intact and still reserved; unwind only the target.
    const current = await prisma.migrationJob.findUniqueOrThrow({ where: { id: job.id } });
    if (current.toNodeId !== current.fromNodeId) {
      await prisma.allocation.updateMany({
        where: { serverId, nodeId: current.toNodeId },
        data: { serverId: null, primary: false },
      });
      await releaseCapacity(current.toNodeId, {
        memoryMb: server.memoryMb,
        diskMb: server.diskMb,
        cpuCores: server.cpuCores,
      });
      await callAgent(current.toNodeId, { op: "server.delete", serverId, wipeVolume: true }).catch(
        () => undefined,
      );
    }
    await prisma.migrationJob.update({
      where: { id: job.id },
      data: { status: "ROLLED_BACK", failureReason: String(err), finishedAt: new Date() },
    });
    throw err;
  }
}

/** Drains a node: disables it, then migrates every server off it one at a time. */
export async function drainNode(nodeId: string, actorId?: string | null) {
  await prisma.node.update({ where: { id: nodeId }, data: { enabled: false } });
  const servers = await prisma.server.findMany({ where: { nodeId }, select: { id: true } });

  const results = [];
  for (const s of servers) {
    try {
      results.push({ serverId: s.id, ...(await migrateServer(s.id, null, actorId)) });
    } catch (err) {
      results.push({ serverId: s.id, error: String(err) });
    }
  }

  await audit({
    actorId,
    action: "node.drain",
    targetType: "node",
    targetId: nodeId,
    metadata: { servers: servers.length },
  });
  return results;
}
