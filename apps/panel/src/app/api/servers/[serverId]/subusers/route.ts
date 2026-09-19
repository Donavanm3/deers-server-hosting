import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireServerAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { fail } from "@/app/api/_helpers";

const PERMISSIONS = [
  "console.view",
  "console.command",
  "power.start",
  "power.stop",
  "files.read",
  "files.write",
  "files.delete",
  "backups.read",
  "backups.create",
] as const;

export async function GET(_req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    await requireServerAccess(serverId, "settings.write");
    const subusers = await prisma.subuser.findMany({
      where: { serverId },
      include: { user: { select: { email: true, displayName: true } } },
    });
    return NextResponse.json({
      available: PERMISSIONS,
      subusers: subusers.map((s) => ({
        id: s.id,
        email: s.user.email,
        displayName: s.user.displayName,
        permissions: s.permissions,
      })),
    });
  } catch (err) {
    return fail(err);
  }
}

const schema = z.object({
  email: z.string().email(),
  permissions: z.array(z.enum(PERMISSIONS)).min(1),
});

export async function POST(req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    // Only the owner or an admin manages access — a subuser can never widen
    // their own permissions or add others.
    const { user, server } = await requireServerAccess(serverId, "settings.write");
    if (user.role !== "ADMIN" && server.ownerId !== user.id) {
      return NextResponse.json({ error: "Only the server owner can manage access." }, { status: 403 });
    }

    const body = schema.parse(await req.json());
    const invitee = await prisma.user.findUnique({ where: { email: body.email } });
    if (!invitee) {
      return NextResponse.json({ error: "No account uses that email address." }, { status: 404 });
    }
    if (invitee.id === server.ownerId) {
      return NextResponse.json({ error: "The owner already has full access." }, { status: 409 });
    }

    const subuser = await prisma.subuser.upsert({
      where: { serverId_userId: { serverId, userId: invitee.id } },
      create: { serverId, userId: invitee.id, permissions: body.permissions },
      update: { permissions: body.permissions },
    });

    await audit({
      actorId: user.id,
      action: "server.subuser.grant",
      targetType: "server",
      targetId: serverId,
      metadata: { subject: invitee.id, permissions: body.permissions },
    });

    return NextResponse.json({ subuser: { id: subuser.id, permissions: subuser.permissions } });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    const { subuserId } = z.object({ subuserId: z.string().uuid() }).parse(await req.json());
    const { user, server } = await requireServerAccess(serverId, "settings.write");
    if (user.role !== "ADMIN" && server.ownerId !== user.id) {
      return NextResponse.json({ error: "Only the server owner can manage access." }, { status: 403 });
    }

    await prisma.subuser.delete({ where: { id: subuserId } });
    await audit({
      actorId: user.id,
      action: "server.subuser.revoke",
      targetType: "server",
      targetId: serverId,
      metadata: { subuserId },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
