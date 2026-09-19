import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { fail } from "@/app/api/_helpers";

export async function GET() {
  try {
    await requireAdmin();
    const plans = await prisma.plan.findMany({
      orderBy: { monthlyPriceCents: "asc" },
      include: { template: { select: { name: true } }, _count: { select: { servers: true } } },
    });
    return NextResponse.json({ plans });
  } catch (err) {
    return fail(err);
  }
}

const schema = z.object({
  name: z.string().min(2).max(48),
  memoryMb: z.number().int().min(512),
  diskMb: z.number().int().min(1024),
  cpuCores: z.number().min(0.25),
  backupMb: z.number().int().min(0).default(0),
  databaseLimit: z.number().int().min(0).default(0),
  allocationLimit: z.number().int().min(1).default(1),
  monthlyPriceCents: z.number().int().min(0),
  templateId: z.string().uuid(),
  visible: z.boolean().default(true),
});

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const body = schema.parse(await req.json());
    const plan = await prisma.plan.create({ data: body });
    await audit({
      actorId: admin.id,
      action: "plan.create",
      targetType: "plan",
      targetId: plan.id,
      metadata: { name: plan.name, priceCents: plan.monthlyPriceCents },
    });
    return NextResponse.json({ plan }, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}
