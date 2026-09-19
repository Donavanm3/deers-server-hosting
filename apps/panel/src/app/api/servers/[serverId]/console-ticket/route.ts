import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { requireServerAccess } from "@/lib/auth";
import { redis } from "@/lib/redis";
import { fail } from "@/app/api/_helpers";

/**
 * Mints a single-use, 30-second ticket for the console socket. The browser gets
 * a ticket, never the node id or the agent token, and the gateway resolves it.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    const { user, server } = await requireServerAccess(serverId, "console.view");

    let canCommand = user.role === "ADMIN" || server.ownerId === user.id;
    if (!canCommand) {
      const sub = server.subusers.find((s) => s.userId === user.id);
      canCommand = !!sub?.permissions.includes("console.command");
    }

    const ticket = randomBytes(24).toString("base64url");
    await redis.set(
      `console:ticket:${ticket}`,
      JSON.stringify({ serverId, nodeId: server.nodeId, canCommand }),
      "EX",
      30,
    );

    return NextResponse.json({
      ticket,
      url: `${process.env.PUBLIC_GATEWAY_WS ?? "wss://panel.example.com"}/console?ticket=${ticket}`,
      canCommand,
    });
  } catch (err) {
    return fail(err);
  }
}
