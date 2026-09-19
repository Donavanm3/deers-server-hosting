import { NextResponse } from "next/server";
import { z } from "zod";
import { requireServerAccess } from "@/lib/auth";
import { readGameSettings, writeGameSettings } from "@/lib/game-settings";
import { audit } from "@/lib/audit";
import { fail } from "@/app/api/_helpers";

export async function GET(_req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    await requireServerAccess(serverId, "settings.write");
    return NextResponse.json(await readGameSettings(serverId));
  } catch (err) {
    return fail(err);
  }
}

const schema = z.object({ values: z.record(z.string().max(512)) });

export async function PATCH(req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    const { user } = await requireServerAccess(serverId, "settings.write");
    const { values } = schema.parse(await req.json());

    const result = await writeGameSettings(serverId, values);
    await audit({
      actorId: user.id,
      action: "server.settings.update",
      targetType: "server",
      targetId: serverId,
      metadata: { keys: result.saved },
    });

    return NextResponse.json(result);
  } catch (err) {
    return fail(err);
  }
}
