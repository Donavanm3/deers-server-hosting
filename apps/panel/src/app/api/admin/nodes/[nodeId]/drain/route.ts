import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { drainNode } from "@/lib/migration";
import { fail } from "@/app/api/_helpers";

/** Disables the node, then moves every server off it one at a time. */
export async function POST(_req: Request, ctx: { params: Promise<{ nodeId: string }> }) {
  try {
    const admin = await requireAdmin();
    const { nodeId } = await ctx.params;
    const results = await drainNode(nodeId, admin.id);

    const failed = results.filter((r) => "error" in r);
    return NextResponse.json({
      moved: results.length - failed.length,
      failed,
      // Anything that failed is still running on the source node, untouched.
      note: failed.length
        ? "Servers that failed to move are still running where they were."
        : "Every server was moved. The node is empty and disabled.",
    });
  } catch (err) {
    return fail(err);
  }
}
