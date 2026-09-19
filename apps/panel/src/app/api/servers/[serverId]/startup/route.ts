import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireServerAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { fail } from "@/app/api/_helpers";

interface TemplateVariable {
  key: string;
  label: string;
  default?: string;
  editable?: boolean;
}

export async function GET(_req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    const { server } = await requireServerAccess(serverId, "settings.write");
    const template = await prisma.gameTemplate.findUniqueOrThrow({ where: { id: server.templateId } });
    const variables = (template.variables ?? []) as TemplateVariable[];
    const current = server.environment as Record<string, string>;

    return NextResponse.json({
      // Only editable variables are exposed; the rest are template internals.
      variables: variables
        .filter((v) => v.editable !== false)
        .map((v) => ({ key: v.key, label: v.label, value: current[v.key] ?? v.default ?? "" })),
    });
  } catch (err) {
    return fail(err);
  }
}

const schema = z.object({ values: z.record(z.string().max(512)) });

export async function PATCH(req: Request, ctx: { params: Promise<{ serverId: string }> }) {
  try {
    const { serverId } = await ctx.params;
    const { user, server } = await requireServerAccess(serverId, "settings.write");
    const { values } = schema.parse(await req.json());

    const template = await prisma.gameTemplate.findUniqueOrThrow({ where: { id: server.templateId } });
    const editable = new Set(
      ((template.variables ?? []) as TemplateVariable[])
        .filter((v) => v.editable !== false)
        .map((v) => v.key),
    );

    // Anything not declared editable is dropped rather than rejected, so a stale
    // form cannot inject environment variables into the container.
    const current = server.environment as Record<string, string>;
    const next = { ...current };
    for (const [key, value] of Object.entries(values)) {
      if (editable.has(key)) next[key] = value;
    }

    await prisma.server.update({ where: { id: serverId }, data: { environment: next } });
    await audit({
      actorId: user.id,
      action: "server.startup.update",
      targetType: "server",
      targetId: serverId,
      metadata: { keys: Object.keys(values).filter((k) => editable.has(k)) },
    });

    return NextResponse.json({
      ok: true,
      note: "Changes apply the next time the server starts.",
    });
  } catch (err) {
    return fail(err);
  }
}
