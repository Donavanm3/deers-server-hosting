import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { fail } from "@/app/api/_helpers";

/**
 * Issues a new agent token. The old one stops working immediately, so the node
 * goes offline until the operator updates /etc/deers/agent.env and restarts the
 * agent — which is the intended behaviour if a token has leaked.
 */
export async function POST(req: Request, ctx: { params: Promise<{ nodeId: string }> }) {
  try {
    const admin = await requireAdmin();
    const { nodeId } = await ctx.params;

    const token = `dsh_${randomBytes(32).toString("base64url")}`;
    const node = await prisma.node.update({
      where: { id: nodeId },
      data: { agentTokenHash: await bcrypt.hash(token, 12) },
    });

    await audit({
      actorId: admin.id,
      action: "node.rotate_token",
      targetType: "node",
      targetId: nodeId,
      ip: req.headers.get("x-forwarded-for"),
    });

    return NextResponse.json({
      agentToken: token,
      warning: `${node.name} will stay offline until its agent.env is updated and the agent restarted.`,
    });
  } catch (err) {
    return fail(err);
  }
}
