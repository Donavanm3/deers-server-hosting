import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { isNodeConnected } from "@/lib/agent-rpc";
import { fail } from "@/app/api/_helpers";

export async function GET() {
  try {
    await requireAdmin();
    const nodes = await prisma.node.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { servers: true } } },
    });

    return NextResponse.json({
      nodes: await Promise.all(
        nodes.map(async (n) => ({
          id: n.id,
          name: n.name,
          location: n.location,
          type: n.type,
          status: n.status,
          enabled: n.enabled,
          connected: await isNodeConnected(n.id),
          lastHeartbeat: n.lastHeartbeat,
          agentVersion: n.agentVersion,
          servers: n._count.servers,
          resources: {
            memory: {
              total: n.totalMemoryMb,
              reserved: n.reservedMemoryMb,
              available: n.totalMemoryMb - n.reservedMemoryMb - n.overheadMemoryMb,
            },
            disk: {
              total: n.totalDiskMb,
              reserved: n.reservedDiskMb,
              available: n.totalDiskMb - n.reservedDiskMb - n.overheadDiskMb,
            },
            cpu: {
              total: n.totalCpuCores,
              reserved: n.reservedCpuCores,
              available: n.totalCpuCores - n.reservedCpuCores,
            },
          },
          live: { cpuPercent: n.liveCpuPercent, memoryMb: n.liveMemoryMb, diskMb: n.liveDiskMb },
        })),
      ),
    });
  } catch (err) {
    return fail(err);
  }
}

const createSchema = z.object({
  name: z.string().min(2).max(64),
  hostname: z.string().min(1),
  location: z.string().min(1),
  type: z.enum(["VPS", "DEDICATED", "HOME"]),
  totalMemoryMb: z.number().int().min(0),
  totalDiskMb: z.number().int().min(0),
  totalCpuCores: z.number().min(0),
  overheadMemoryMb: z.number().int().min(0).default(1024),
  overheadDiskMb: z.number().int().min(0).default(10240),
  templateIds: z.array(z.string()).default([]),
  allocationIp: z.string().default("0.0.0.0"),
  portRangeStart: z.number().int().min(1024).default(25565),
  portRangeEnd: z.number().int().max(65535).default(25700),
});

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const body = createSchema.parse(await req.json());

    // Shown to the admin exactly once, then only ever stored hashed.
    const token = `dsh_${randomBytes(32).toString("base64url")}`;

    const node = await prisma.$transaction(async (tx) => {
      const created = await tx.node.create({
        data: {
          name: body.name,
          hostname: body.hostname,
          location: body.location,
          type: body.type,
          totalMemoryMb: body.totalMemoryMb,
          totalDiskMb: body.totalDiskMb,
          totalCpuCores: body.totalCpuCores,
          overheadMemoryMb: body.overheadMemoryMb,
          overheadDiskMb: body.overheadDiskMb,
          agentTokenHash: await bcrypt.hash(token, 12),
          daemonPortRangeStart: body.portRangeStart,
          daemonPortRangeEnd: body.portRangeEnd,
          templates: { create: body.templateIds.map((templateId) => ({ templateId })) },
        },
      });

      const ports = [];
      for (let p = body.portRangeStart; p <= body.portRangeEnd; p++) {
        ports.push({ nodeId: created.id, ip: body.allocationIp, port: p });
      }
      if (ports.length) await tx.allocation.createMany({ data: ports, skipDuplicates: true });
      return created;
    });

    await audit({
      actorId: admin.id,
      action: "node.create",
      targetType: "node",
      targetId: node.id,
      metadata: { name: node.name, type: node.type, location: node.location },
      ip: req.headers.get("x-forwarded-for"),
    });

    return NextResponse.json(
      {
        node: { id: node.id, name: node.name },
        agentToken: token, // displayed once; regenerating is the only recovery path
        agentEnv: [
          `DEERS_PANEL_URL=${process.env.PUBLIC_GATEWAY_URL ?? "wss://panel.example.com/agent"}`,
          `DEERS_NODE_ID=${node.id}`,
          `DEERS_NODE_TOKEN=${token}`,
        ].join("\n"),
      },
      { status: 201 },
    );
  } catch (err) {
    return fail(err);
  }
}
