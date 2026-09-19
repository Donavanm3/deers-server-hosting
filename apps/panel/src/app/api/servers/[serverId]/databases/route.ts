import { NextResponse } from "next/server";
import { z } from "zod";
import { requireServerAccess } from "@/lib/auth";
import {
  createDatabase,
  deleteDatabase,
  listDatabases,
  rotateDatabasePassword,
  DatabaseLimitError,
} from "@/lib/databases";
import { fail } from "@/app/api/_helpers";

export async function GET(_req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    // Credentials are only ever returned to someone already authorised here.
    await requireServerAccess(serverId, "settings.write");
    return NextResponse.json({ databases: await listDatabases(serverId) });
  } catch (err) {
    return fail(err);
  }
}

const postSchema = z.union([
  z.object({ action: z.literal("create"), name: z.string().min(1).max(32) }),
  z.object({ action: z.literal("rotate"), databaseId: z.string().uuid() }),
]);

export async function POST(req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    const { user } = await requireServerAccess(serverId, "settings.write");
    const body = postSchema.parse(await req.json());

    if (body.action === "create") {
      return NextResponse.json({ database: await createDatabase(serverId, body.name, user.id) }, { status: 201 });
    }
    return NextResponse.json(await rotateDatabasePassword(serverId, body.databaseId));
  } catch (err) {
    if (err instanceof DatabaseLimitError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return fail(err);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    const { databaseId } = z.object({ databaseId: z.string().uuid() }).parse(await req.json());
    const { user } = await requireServerAccess(serverId, "settings.write");
    await deleteDatabase(serverId, databaseId, user.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
