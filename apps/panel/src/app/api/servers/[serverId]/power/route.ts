import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireServerAccess } from "@/lib/auth";
import { callAgent } from "@/lib/agent-rpc";
import { audit } from "@/lib/audit";
import { fail } from "@/app/api/_helpers";

const schema = z.object({ action: z.enum(["start", "stop", "restart", "kill"]) });

export async function POST(req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    const { action } = schema.parse(await req.json());

    const { user, server } = await requireServerAccess(
      serverId,
      action === "start" ? "power.start" : "power.stop",
    );

    if (server.suspended) {
      return NextResponse.json(
        { error: "This server is suspended. Settle the outstanding invoice to start it again." },
        { status: 409 },
      );
    }

    const template = await prisma.gameTemplate.findUniqueOrThrow({ where: { id: server.templateId } });

    await prisma.server.update({
      where: { id: serverId },
      data: { status: action === "start" ? "STARTING" : action === "stop" ? "STOPPING" : "STARTING" },
    });

    // The node id lives only on the server side of this call.
    await callAgent(
      server.nodeId,
      action === "start"
        ? { op: "server.start", serverId }
        : action === "stop"
          ? { op: "server.stop", serverId, stopCommand: template.stopCommand, timeoutSeconds: 30 }
          : action === "restart"
            ? { op: "server.restart", serverId }
            : { op: "server.kill", serverId },
      60_000,
    );

    await audit({
      actorId: user.id,
      action: `server.power.${action}`,
      targetType: "server",
      targetId: serverId,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
