import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { recalculateNodeReservations } from "@/lib/scheduler";
import { fail } from "@/app/api/_helpers";

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().min(2).optional(),
  location: z.string().min(1).optional(),
  totalMemoryMb: z.number().int().min(0).optional(),
  totalDiskMb: z.number().int().min(0).optional(),
  totalCpuCores: z.number().min(0).optional(),
  recalculate: z.boolean().optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ nodeId: string }> }) {
  try {
    const admin = await requireAdmin();
    const { nodeId } = await ctx.params;
    const { recalculate, ...data } = patchSchema.parse(await req.json());

    if (recalculate) await recalculateNodeReservations(nodeId);

    const node = Object.keys(data).length
      ? await prisma.node.update({ where: { id: nodeId }, data })
      : await prisma.node.findUniqueOrThrow({ where: { id: nodeId } });

    // Shrinking totals below what is already reserved would oversell the node.
    if (
      node.totalMemoryMb - node.reservedMemoryMb < 0 ||
      node.totalDiskMb - node.reservedDiskMb < 0 ||
      node.totalCpuCores - node.reservedCpuCores < 0
    ) {
      throw new Error("New totals are below the resources already reserved on this node.");
    }

    if (data.enabled !== undefined) {
      // Disabling stops new placements; running servers are untouched.
      await audit({
        actorId: admin.id,
        action: data.enabled ? "node.enable" : "node.disable",
        targetType: "node",
        targetId: nodeId,
        ip: req.headers.get("x-forwarded-for"),
      });
    }

    return NextResponse.json({ node });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ nodeId: string }> }) {
  try {
    const admin = await requireAdmin();
    const { nodeId } = await ctx.params;
    const count = await prisma.server.count({ where: { nodeId } });
    if (count > 0) {
      return NextResponse.json(
        { error: `This node still hosts ${count} server(s). Move or delete them first.` },
        { status: 409 },
      );
    }
    await prisma.node.delete({ where: { id: nodeId } });
    await audit({ actorId: admin.id, action: "node.delete", targetType: "node", targetId: nodeId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
