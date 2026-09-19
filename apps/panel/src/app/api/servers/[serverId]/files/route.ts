import { NextResponse } from "next/server";
import { z } from "zod";
import { requireServerAccess } from "@/lib/auth";
import { callAgent } from "@/lib/agent-rpc";
import { audit } from "@/lib/audit";
import { fail } from "@/app/api/_helpers";
import type { FileEntry } from "@deers/shared/protocol";

export async function GET(req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    const { server } = await requireServerAccess(serverId, "files.read");
    const url = new URL(req.url);
    const path = url.searchParams.get("path") ?? "/";
    const file = url.searchParams.get("file");

    if (file) {
      const res = await callAgent<{ contentBase64: string }>(server.nodeId, {
        op: "files.read",
        serverId,
        path: file,
        maxBytes: 2_000_000,
      });
      return NextResponse.json({ content: Buffer.from(res.contentBase64, "base64").toString("utf8") });
    }

    const res = await callAgent<{ entries: FileEntry[] }>(server.nodeId, {
      op: "files.list",
      serverId,
      path,
    });
    return NextResponse.json({ path, entries: res.entries });
  } catch (err) {
    return fail(err);
  }
}

const writeSchema = z.object({ path: z.string().min(1), content: z.string() });

export async function PUT(req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    const { user, server } = await requireServerAccess(serverId, "files.write");
    const body = writeSchema.parse(await req.json());

    await callAgent(server.nodeId, {
      op: "files.write",
      serverId,
      path: body.path,
      contentBase64: Buffer.from(body.content, "utf8").toString("base64"),
    });
    await audit({
      actorId: user.id,
      action: "server.file.write",
      targetType: "server",
      targetId: serverId,
      metadata: { path: body.path },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}

const deleteSchema = z.object({ paths: z.array(z.string().min(1)).min(1).max(100) });

export async function DELETE(req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    const { user, server } = await requireServerAccess(serverId, "files.delete");
    const body = deleteSchema.parse(await req.json());

    await callAgent(server.nodeId, { op: "files.delete", serverId, paths: body.paths });
    await audit({
      actorId: user.id,
      action: "server.file.delete",
      targetType: "server",
      targetId: serverId,
      metadata: { count: body.paths.length },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
