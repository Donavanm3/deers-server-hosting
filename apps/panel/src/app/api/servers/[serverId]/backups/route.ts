import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireServerAccess } from "@/lib/auth";
import { createBackup, deleteBackup, restoreBackup, BackupQuotaError } from "@/lib/backups";
import { fail } from "@/app/api/_helpers";

export async function GET(_req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    await requireServerAccess(serverId, "backups.read");
    const backups = await prisma.backup.findMany({
      where: { serverId },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({
      backups: backups.map((b) => ({
        id: b.id,
        name: b.name,
        bytes: Number(b.bytes), // BigInt is not JSON-serialisable
        completed: b.completed,
        createdAt: b.createdAt,
      })),
    });
  } catch (err) {
    return fail(err);
  }
}

const postSchema = z.union([
  z.object({ action: z.literal("create"), name: z.string().min(1).max(64) }),
  z.object({ action: z.literal("restore"), backupId: z.string().uuid() }),
]);

export async function POST(req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    const body = postSchema.parse(await req.json());
    const { user } = await requireServerAccess(serverId, "backups.create");

    if (body.action === "create") {
      const backup = await createBackup(serverId, body.name, user.id);
      return NextResponse.json({ backup: { id: backup.id, bytes: Number(backup.bytes) } }, { status: 201 });
    }

    await restoreBackup(serverId, body.backupId, user.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof BackupQuotaError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return fail(err);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    const { backupId } = z.object({ backupId: z.string().uuid() }).parse(await req.json());
    const { user } = await requireServerAccess(serverId, "backups.create");
    await deleteBackup(serverId, backupId, user.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
