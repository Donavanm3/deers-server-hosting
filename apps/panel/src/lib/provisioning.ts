import { customAlphabet } from "nanoid";
import { prisma } from "./db";
import { audit } from "./audit";
import { callAgent } from "./agent-rpc";
import {
  NoCapacityError,
  claimAllocation,
  releaseCapacity,
  reserveCapacity,
} from "./scheduler";
import type { CreateServerSpec } from "@deers/shared/protocol";

const shortId = customAlphabet("abcdefghijkmnpqrstuvwxyz23456789", 8);

export interface ProvisionInput {
  orderId: string;
  ownerId: string;
  planId: string;
  serverName: string;
  preferredLocation?: string | null;
  actorId?: string | null;
}

/**
 * Purchase -> running server.
 *
 * Phase 1 (transactional): pick a node, reserve its resources, claim a port,
 *   write the Server row. All or nothing.
 * Phase 2 (network): ask the agent to build the container. If this fails the
 *   reservation from phase 1 is explicitly released and the order is marked
 *   FAILED, so a bad node cannot silently eat capacity.
 */
export async function provisionServer(input: ProvisionInput) {
  const plan = await prisma.plan.findUniqueOrThrow({
    where: { id: input.planId },
    include: { template: true },
  });
  if (!plan.template) throw new Error(`Plan "${plan.name}" has no game template assigned.`);
  const template = plan.template;

  const existing = await prisma.order.findUnique({ where: { id: input.orderId } });
  if (existing?.serverId) {
    // Idempotency: a retried webhook must not provision a second server.
    return prisma.server.findUniqueOrThrow({ where: { id: existing.serverId } });
  }

  const attemptedNodes: string[] = [];
  let lastError: unknown;

  // Up to three placements — if one node's agent fails the build, try the next.
  for (let attempt = 0; attempt < 3; attempt++) {
    let created: {
      server: Awaited<ReturnType<typeof prisma.server.findUniqueOrThrow>>;
      allocation: { ip: string; port: number };
      nodeId: string;
    };

    try {
      const { result } = await reserveCapacity(
        {
          memoryMb: plan.memoryMb,
          diskMb: plan.diskMb,
          cpuCores: plan.cpuCores,
          templateId: template.id,
          preferredLocation: input.preferredLocation,
          excludeNodeIds: attemptedNodes,
        },
        async (tx, reservation) => {
          const sid = shortId();
          const server = await tx.server.create({
            data: {
              shortId: sid,
              name: input.serverName,
              ownerId: input.ownerId,
              nodeId: reservation.nodeId,
              planId: plan.id,
              templateId: template.id,
              status: "PROVISIONING",
              memoryMb: plan.memoryMb,
              diskMb: plan.diskMb,
              cpuCores: plan.cpuCores,
              environment: defaultEnvironment(template.variables),
            },
          });
          const allocation = await claimAllocation(tx, reservation.nodeId, server.id);
          await tx.order.update({
            where: { id: input.orderId },
            data: { status: "PROVISIONED", serverId: server.id },
          });
          return { server, allocation, nodeId: reservation.nodeId };
        },
      );
      created = result;
    } catch (err) {
      if (err instanceof NoCapacityError) throw err;
      lastError = err;
      continue;
    }

    attemptedNodes.push(created.nodeId);

    const spec: CreateServerSpec = {
      serverId: created.server.id,
      shortId: created.server.shortId,
      image: template.dockerImage,
      startCommand: template.startCommand,
      stopCommand: template.stopCommand,
      environment: {
        ...(created.server.environment as Record<string, string>),
        SERVER_PORT: String(created.allocation.port),
        SERVER_MEMORY: String(plan.memoryMb),
      },
      memoryMb: plan.memoryMb,
      diskMb: plan.diskMb,
      cpuCores: plan.cpuCores,
      ports: [
        { ip: created.allocation.ip, port: created.allocation.port, protocol: "tcp" },
        { ip: created.allocation.ip, port: created.allocation.port, protocol: "udp" },
      ],
    };

    try {
      const res = await callAgent<{ containerId: string }>(
        created.nodeId,
        { op: "server.create", spec },
        120_000,
      );
      const server = await prisma.server.update({
        where: { id: created.server.id },
        data: { containerId: res.containerId, status: "OFFLINE" },
      });

      // First billing period starts the moment the server exists. Without this
      // a new server was never invoiced and never renewed — it just ran free
      // until someone noticed.
      const { createInvoiceForServer } = await import("./billing");
      await createInvoiceForServer(server.id).catch((err) =>
        console.error(`[provisioning] first invoice failed for ${server.id}:`, err),
      );

      await audit({
        actorId: input.actorId,
        action: "server.provision",
        targetType: "server",
        targetId: server.id,
        metadata: { nodeId: created.nodeId, planId: plan.id, attempt },
      });
      return server;
    } catch (err) {
      lastError = err;
      // Roll the reservation back so the capacity is immediately re-offerable.
      await prisma.$transaction(async (tx) => {
        await tx.allocation.updateMany({
          where: { serverId: created.server.id },
          data: { serverId: null, primary: false },
        });
        await tx.server.delete({ where: { id: created.server.id } });
        await releaseCapacity(
          created.nodeId,
          { memoryMb: plan.memoryMb, diskMb: plan.diskMb, cpuCores: plan.cpuCores },
          tx,
        );
        await tx.order.update({
          where: { id: input.orderId },
          data: { status: "PENDING", serverId: null },
        });
      });
      await audit({
        actorId: input.actorId,
        action: "server.provision_failed",
        targetType: "order",
        targetId: input.orderId,
        metadata: { nodeId: created.nodeId, error: String(err) },
      });
    }
  }

  await prisma.order.update({
    where: { id: input.orderId },
    data: { status: "FAILED", failureReason: String(lastError) },
  });
  throw new Error(`Provisioning failed on all candidate nodes: ${String(lastError)}`);
}

export async function deleteServer(serverId: string, actorId?: string | null) {
  const server = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
  await prisma.server.update({ where: { id: serverId }, data: { status: "DELETING" } });

  // Drop MySQL schemas first: the cascade on Server would remove our record of
  // them and leave the databases orphaned on the host forever.
  const { dropAllDatabases } = await import("./databases");
  await dropAllDatabases(serverId).catch((err) =>
    console.error(`[provisioning] database cleanup failed for ${serverId}:`, err),
  );

  try {
    await callAgent(server.nodeId, { op: "server.delete", serverId, wipeVolume: true }, 60_000);
  } catch (err) {
    // The node may be down. Capacity is still released; the reconciler removes
    // the orphaned container when the agent reconnects.
    await audit({
      actorId,
      action: "server.delete_agent_failed",
      targetType: "server",
      targetId: serverId,
      metadata: { error: String(err) },
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.allocation.updateMany({ where: { serverId }, data: { serverId: null, primary: false } });
    await tx.server.delete({ where: { id: serverId } });
    await releaseCapacity(
      server.nodeId,
      { memoryMb: server.memoryMb, diskMb: server.diskMb, cpuCores: server.cpuCores },
      tx,
    );
  });

  await audit({
    actorId,
    action: "server.delete",
    targetType: "server",
    targetId: serverId,
    metadata: { nodeId: server.nodeId },
  });
}

function defaultEnvironment(variables: unknown): Record<string, string> {
  if (!Array.isArray(variables)) return {};
  const out: Record<string, string> = {};
  for (const v of variables as { key: string; default?: string }[]) {
    if (v?.key) out[v.key] = v.default ?? "";
  }
  return out;
}
