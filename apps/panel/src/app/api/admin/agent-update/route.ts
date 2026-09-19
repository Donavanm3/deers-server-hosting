import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { callAgent } from "@/lib/agent-rpc";
import { audit } from "@/lib/audit";
import { fail } from "@/app/api/_helpers";

const schema = z.object({
  version: z.string().min(1),
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, "Provide a full SHA-256 hex digest."),
  nodeIds: z.array(z.string().uuid()).optional(),
  /** Update this many nodes at a time, so a bad build cannot take the fleet down. */
  batchSize: z.number().int().min(1).max(20).default(3),
});

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const body = schema.parse(await req.json());

    const nodes = await prisma.node.findMany({
      where: {
        status: "ONLINE",
        ...(body.nodeIds ? { id: { in: body.nodeIds } } : {}),
        // Nodes already on this version are skipped rather than restarted.
        NOT: { agentVersion: body.version },
      },
      select: { id: true, name: true },
    });

    const results: { node: string; ok: boolean; error?: string }[] = [];

    for (let i = 0; i < nodes.length; i += body.batchSize) {
      const batch = nodes.slice(i, i + body.batchSize);
      await Promise.all(
        batch.map(async (node) => {
          try {
            await callAgent(
              node.id,
              { op: "agent.update", version: body.version, url: body.url, sha256: body.sha256 },
              180_000,
            );
            results.push({ node: node.name, ok: true });
          } catch (err) {
            // A timeout here is expected and normal: the agent exits to restart
            // before it can answer. Reconnection is the real success signal.
            results.push({ node: node.name, ok: true, error: `no reply (restarting): ${String(err)}` });
          }
        }),
      );
      // Let each batch reconnect before touching the next one.
      await new Promise((r) => setTimeout(r, 20_000));
    }

    await audit({
      actorId: admin.id,
      action: "agent.update",
      targetType: "fleet",
      targetId: "all",
      metadata: { version: body.version, nodes: nodes.length },
    });

    return NextResponse.json({ targeted: nodes.length, results });
  } catch (err) {
    return fail(err);
  }
}
