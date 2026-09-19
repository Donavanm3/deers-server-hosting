import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { reserveCapacity, releaseCapacity, NoCapacityError } from "../apps/panel/src/lib/scheduler";

/**
 * These run against a real Postgres (DATABASE_URL) because the behaviour under
 * test IS the database's locking — an in-memory mock would prove nothing.
 */
const prisma = new PrismaClient();
let templateId: string;

async function makeNode(memoryMb: number, diskMb: number, cpuCores: number) {
  return prisma.node.create({
    data: {
      name: `test-${Math.random().toString(36).slice(2, 10)}`,
      hostname: "127.0.0.1",
      location: "test",
      type: "VPS",
      status: "ONLINE",
      lastHeartbeat: new Date(),
      totalMemoryMb: memoryMb,
      totalDiskMb: diskMb,
      totalCpuCores: cpuCores,
      overheadMemoryMb: 0,
      overheadDiskMb: 0,
      agentTokenHash: await bcrypt.hash("test-token", 4),
      templates: { create: [{ templateId }] },
    },
  });
}

beforeEach(async () => {
  await prisma.nodeTemplate.deleteMany();
  await prisma.node.deleteMany({ where: { location: "test" } });
  const t = await prisma.gameTemplate.upsert({
    where: { key: "test-template" },
    update: {},
    create: {
      key: "test-template",
      name: "Test",
      dockerImage: "alpine:latest",
      startCommand: "sleep infinity",
    },
  });
  templateId = t.id;
});

afterAll(() => prisma.$disconnect());

describe("reserveCapacity", () => {
  it("reserves exactly what the plan asks for", async () => {
    const node = await makeNode(65536, 512000, 16);

    await reserveCapacity(
      { memoryMb: 8192, diskMb: 307200, cpuCores: 2, templateId },
      async () => undefined,
    );

    const after = await prisma.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(after.reservedMemoryMb).toBe(8192);
    expect(after.reservedDiskMb).toBe(307200);
    expect(after.reservedCpuCores).toBe(2);
  });

  it("never lets two concurrent purchases oversell the same node", async () => {
    // 16 GB node, ten simultaneous 2 GB purchases: exactly eight can fit.
    const node = await makeNode(16384, 500000, 32);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        reserveCapacity({ memoryMb: 2048, diskMb: 1024, cpuCores: 1, templateId }, async () => undefined),
      ),
    );

    const granted = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof NoCapacityError,
    ).length;

    expect(granted).toBe(8);
    expect(refused).toBe(2);

    const after = await prisma.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(after.reservedMemoryMb).toBe(16384);
    expect(after.totalMemoryMb - after.reservedMemoryMb).toBeGreaterThanOrEqual(0);
  });

  it("rolls the reservation back when the caller throws", async () => {
    const node = await makeNode(8192, 100000, 4);

    await expect(
      reserveCapacity({ memoryMb: 4096, diskMb: 1024, cpuCores: 1, templateId }, async () => {
        throw new Error("container build failed");
      }),
    ).rejects.toThrow("container build failed");

    const after = await prisma.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(after.reservedMemoryMb).toBe(0);
  });

  it("skips disabled and stale nodes", async () => {
    const disabled = await makeNode(65536, 500000, 16);
    await prisma.node.update({ where: { id: disabled.id }, data: { enabled: false } });

    await expect(
      reserveCapacity({ memoryMb: 1024, diskMb: 1024, cpuCores: 1, templateId }, async () => undefined),
    ).rejects.toBeInstanceOf(NoCapacityError);

    const stale = await makeNode(65536, 500000, 16);
    await prisma.node.update({
      where: { id: stale.id },
      data: { lastHeartbeat: new Date(Date.now() - 5 * 60_000) },
    });

    await expect(
      reserveCapacity({ memoryMb: 1024, diskMb: 1024, cpuCores: 1, templateId }, async () => undefined),
    ).rejects.toBeInstanceOf(NoCapacityError);
  });

  it("prefers the node with the best balance after placement", async () => {
    const loaded = await makeNode(32768, 500000, 16);
    await prisma.node.update({
      where: { id: loaded.id },
      data: { reservedMemoryMb: 24576, reservedCpuCores: 12 },
    });
    const fresh = await makeNode(32768, 500000, 16);

    const { reservation } = await reserveCapacity(
      { memoryMb: 4096, diskMb: 10240, cpuCores: 2, templateId },
      async () => undefined,
    );

    expect(reservation.nodeId).toBe(fresh.id);
  });

  it("releases capacity back to the pool", async () => {
    const node = await makeNode(8192, 100000, 4);
    await reserveCapacity({ memoryMb: 4096, diskMb: 1024, cpuCores: 2, templateId }, async () => undefined);
    await releaseCapacity(node.id, { memoryMb: 4096, diskMb: 1024, cpuCores: 2 });

    const after = await prisma.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(after.reservedMemoryMb).toBe(0);
    expect(after.reservedCpuCores).toBe(0);
  });
});
