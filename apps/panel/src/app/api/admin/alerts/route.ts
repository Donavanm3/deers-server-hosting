import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { resolveAlert } from "@/lib/alerts";
import { fail } from "@/app/api/_helpers";

export async function GET(req: Request) {
  try {
    await requireAdmin();
    const includeResolved = new URL(req.url).searchParams.get("resolved") === "true";
    const alerts = await prisma.alert.findMany({
      where: includeResolved ? {} : { resolvedAt: null },
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
      take: 200,
    });
    return NextResponse.json({ alerts });
  } catch (err) {
    return fail(err);
  }
}

/** Manual acknowledgement. The next health pass re-raises it if still true. */
export async function POST(req: Request) {
  try {
    await requireAdmin();
    const { key } = z.object({ key: z.string().min(1) }).parse(await req.json());
    await resolveAlert(key);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
