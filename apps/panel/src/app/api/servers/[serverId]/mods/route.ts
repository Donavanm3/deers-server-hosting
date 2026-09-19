import { NextResponse } from "next/server";
import { z } from "zod";
import { requireServerAccess } from "@/lib/auth";
import {
  installFromModrinth,
  installFromUrl,
  installUpload,
  listInstalled,
  removeMod,
  searchMods,
  slotsForServer,
  ModError,
} from "@/lib/mods";
import { fail } from "@/app/api/_helpers";

export async function GET(req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    await requireServerAccess(serverId, "files.read");

    const query = new URL(req.url).searchParams.get("search");
    if (query) return NextResponse.json({ results: await searchMods(serverId, query) });

    const [slots, installed] = await Promise.all([slotsForServer(serverId), listInstalled(serverId)]);
    return NextResponse.json({ slots, installed });
  } catch (err) {
    if (err instanceof ModError) return NextResponse.json({ error: err.message }, { status: 400 });
    return fail(err);
  }
}

const jsonSchema = z.union([
  z.object({ source: z.literal("url"), slotId: z.string(), url: z.string().url() }),
  z.object({ source: z.literal("modrinth"), projectId: z.string().min(1) }),
]);

export async function POST(req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    const { user } = await requireServerAccess(serverId, "files.write");
    const contentType = req.headers.get("content-type") ?? "";

    // Browser uploads arrive as multipart; everything else is JSON.
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      const slotId = String(form.get("slotId") ?? "");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "Choose a file to upload." }, { status: 400 });
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      return NextResponse.json({
        installed: await installUpload(serverId, slotId, file.name, bytes, user.id),
      });
    }

    const body = jsonSchema.parse(await req.json());
    if (body.source === "url") {
      return NextResponse.json({
        installed: await installFromUrl(serverId, body.slotId, body.url, user.id),
      });
    }
    return NextResponse.json({
      installed: await installFromModrinth(serverId, body.projectId, user.id),
    });
  } catch (err) {
    if (err instanceof ModError) return NextResponse.json({ error: err.message }, { status: 400 });
    return fail(err);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    const { user } = await requireServerAccess(serverId, "files.delete");
    const { slotId, filename } = z
      .object({ slotId: z.string(), filename: z.string().min(1) })
      .parse(await req.json());

    await removeMod(serverId, slotId, filename, user.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ModError) return NextResponse.json({ error: err.message }, { status: 400 });
    return fail(err);
  }
}
