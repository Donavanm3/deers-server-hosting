import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { fail } from "@/app/api/_helpers";

/** Audit trail, filterable and cursor-paged so it stays fast as it grows. */
export async function GET(req: Request) {
  try {
    await requireAdmin();
    const url = new URL(req.url);
    const action = url.searchParams.get("action");
    const targetId = url.searchParams.get("targetId");
    const cursor = url.searchParams.get("cursor");
    const take = Math.min(100, Number(url.searchParams.get("limit") ?? 50));

    const logs = await prisma.auditLog.findMany({
      where: {
        ...(action ? { action: { startsWith: action } } : {}),
        ...(targetId ? { targetId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { actor: { select: { email: true, displayName: true } } },
    });

    const hasMore = logs.length > take;
    return NextResponse.json({
      logs: logs.slice(0, take),
      nextCursor: hasMore ? logs[take - 1].id : null,
    });
  } catch (err) {
    return fail(err);
  }
}
