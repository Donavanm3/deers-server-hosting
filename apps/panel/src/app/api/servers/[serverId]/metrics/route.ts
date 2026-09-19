import { NextResponse } from "next/server";
import { requireServerAccess } from "@/lib/auth";
import { serverHistory } from "@/lib/metrics";
import { fail } from "@/app/api/_helpers";

export async function GET(req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    await requireServerAccess(serverId, "console.view");
    const hours = Math.min(720, Number(new URL(req.url).searchParams.get("hours") ?? 24));
    return NextResponse.json({ points: await serverHistory(serverId, hours) });
  } catch (err) {
    return fail(err);
  }
}
