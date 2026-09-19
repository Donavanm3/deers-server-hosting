import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { fail } from "@/app/api/_helpers";

export async function GET() {
  try {
    const user = await requireUser();
    const invoices = await prisma.invoice.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { server: { select: { name: true } } },
    });

    return NextResponse.json({
      invoices: invoices.map((i) => ({
        id: i.id,
        number: i.number,
        status: i.status,
        amountCents: i.amountCents,
        currency: i.currency,
        server: i.server?.name ?? null,
        periodStart: i.periodStart,
        periodEnd: i.periodEnd,
        dueAt: i.dueAt,
        paidAt: i.paidAt,
      })),
    });
  } catch (err) {
    return fail(err);
  }
}
