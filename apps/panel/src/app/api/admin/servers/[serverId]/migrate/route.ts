import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { migrateServer } from "@/lib/migration";
import { fail } from "@/app/api/_helpers";

const schema = z.object({ targetNodeId: z.string().uuid().nullable().default(null) });

export async function POST(req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const admin = await requireAdmin();
    const { serverId } = await ctx.params;
    const { targetNodeId } = schema.parse(await req.json());

    // Long-running; the client polls the migration job for progress.
    const result = await migrateServer(serverId, targetNodeId, admin.id);
    return NextResponse.json(result);
  } catch (err) {
    return fail(err);
  }
}
