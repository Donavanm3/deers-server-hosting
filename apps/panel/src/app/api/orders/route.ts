import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { provisionServer } from "@/lib/provisioning";
import { fail } from "@/app/api/_helpers";

const schema = z.object({
  planId: z.string().uuid(),
  serverName: z.string().min(1).max(48),
  location: z.string().optional(),
});

/**
 * Purchase flow. Payment capture belongs in stage 6; today the order is created
 * PAID in development and the provisioning path is identical either way.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = schema.parse(await req.json());

    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: body.planId } });
    if (!plan.visible) return NextResponse.json({ error: "This plan is not available." }, { status: 404 });

    const order = await prisma.order.create({
      data: { userId: user.id, planId: plan.id, status: "PAID" },
    });

    const server = await provisionServer({
      orderId: order.id,
      ownerId: user.id,
      planId: plan.id,
      serverName: body.serverName,
      preferredLocation: body.location ?? null,
      actorId: user.id,
    });

    return NextResponse.json(
      {
        order: { id: order.id, status: "PROVISIONED" },
        server: { id: server.id, shortId: server.shortId, name: server.name, status: server.status },
      },
      { status: 201 },
    );
  } catch (err) {
    return fail(err);
  }
}
