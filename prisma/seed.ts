import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

/** Seeds only real, usable records: an admin, game templates, and sellable plans. */
async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@dashlith.com";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword) throw new Error("Set SEED_ADMIN_PASSWORD before seeding.");

  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      displayName: "Administrator",
      passwordHash: await bcrypt.hash(adminPassword, 12),
      role: "ADMIN",
    },
  });

  const templates = [
    {
      key: "minecraft-java",
      name: "Minecraft: Java Edition",
      dockerImage: "itzg/minecraft-server:java21",
      startCommand: "/start",
      stopCommand: "stop",
      readyRegex: 'Done \\(.*\\)! For help',
      variables: [
        { key: "EULA", label: "Accept the Minecraft EULA", default: "TRUE", editable: false },
        { key: "VERSION", label: "Game version", default: "1.21.1", editable: true },
        { key: "TYPE", label: "Server software", default: "PAPER", editable: true },
        { key: "MEMORY", label: "Heap size", default: "", editable: false },
      ],
    },
    {
      key: "minecraft-bedrock",
      name: "Minecraft: Bedrock Edition",
      dockerImage: "itzg/minecraft-bedrock-server:latest",
      startCommand: "/opt/bedrock-entry.sh",
      stopCommand: "stop",
      readyRegex: "Server started",
      variables: [
        { key: "EULA", label: "Accept the Minecraft EULA", default: "TRUE", editable: false },
        { key: "GAMEMODE", label: "Default game mode", default: "survival", editable: true },
      ],
    },
  ];

  for (const t of templates) {
    await prisma.gameTemplate.upsert({
      where: { key: t.key },
      update: { name: t.name, dockerImage: t.dockerImage },
      create: t,
    });
  }

  const java = await prisma.gameTemplate.findUniqueOrThrow({ where: { key: "minecraft-java" } });

  const plans = [
    { name: "Sapling", memoryMb: 2048, diskMb: 10240, cpuCores: 1, backupMb: 5120, databaseLimit: 1, monthlyPriceCents: 500 },
    { name: "Thicket", memoryMb: 4096, diskMb: 25600, cpuCores: 2, backupMb: 20480, databaseLimit: 2, monthlyPriceCents: 1000 },
    { name: "Old Growth", memoryMb: 8192, diskMb: 51200, cpuCores: 4, backupMb: 51200, databaseLimit: 4, monthlyPriceCents: 2000 },
  ];

  for (const p of plans) {
    const existing = await prisma.plan.findFirst({ where: { name: p.name } });
    if (!existing) await prisma.plan.create({ data: { ...p, templateId: java.id } });
  }

  console.log("Seeded admin, templates and plans.");
}

main().finally(() => prisma.$disconnect());
