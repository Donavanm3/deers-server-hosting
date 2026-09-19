import { prisma } from "./db";

export async function audit(params: {
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}) {
  await prisma.auditLog.create({
    data: {
      actorId: params.actorId ?? null,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
      metadata: (params.metadata ?? {}) as object,
      ip: params.ip ?? null,
    },
  });
}
