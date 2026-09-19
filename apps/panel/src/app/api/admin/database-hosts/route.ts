import { NextResponse } from "next/server";
import { z } from "zod";
import mysql from "mysql2/promise";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import { fail } from "@/app/api/_helpers";

export async function GET() {
  try {
    await requireAdmin();
    const hosts = await prisma.databaseHost.findMany({
      include: { _count: { select: { databases: true } }, node: { select: { name: true } } },
    });
    // The admin password is never returned, not even to an admin.
    return NextResponse.json({
      hosts: hosts.map((h) => ({
        id: h.id,
        name: h.name,
        host: h.host,
        port: h.port,
        node: h.node?.name ?? "shared",
        databases: h._count.databases,
        maxDatabases: h.maxDatabases,
        enabled: h.enabled,
      })),
    });
  } catch (err) {
    return fail(err);
  }
}

const schema = z.object({
  name: z.string().min(2).max(48),
  host: z.string().min(1),
  adminHost: z.string().min(1),
  port: z.number().int().default(3306),
  adminUser: z.string().min(1),
  adminPassword: z.string().min(8),
  nodeId: z.string().uuid().nullable().default(null),
  maxDatabases: z.number().int().min(1).default(100),
});

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const body = schema.parse(await req.json());

    // Verify the credentials work before storing them, so a typo surfaces now
    // rather than the first time a customer tries to create a database.
    const conn = await mysql.createConnection({
      host: body.adminHost,
      port: body.port,
      user: body.adminUser,
      password: body.adminPassword,
    });
    try {
      await conn.query("SELECT 1");
    } finally {
      await conn.end();
    }

    const host = await prisma.databaseHost.create({
      data: {
        name: body.name,
        host: body.host,
        adminHost: body.adminHost,
        port: body.port,
        adminUser: body.adminUser,
        adminPasswordEnc: encryptSecret(body.adminPassword),
        nodeId: body.nodeId,
        maxDatabases: body.maxDatabases,
      },
    });

    await audit({
      actorId: admin.id,
      action: "database_host.create",
      targetType: "database_host",
      targetId: host.id,
      metadata: { name: host.name, nodeId: host.nodeId },
    });

    return NextResponse.json({ host: { id: host.id, name: host.name } }, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}
