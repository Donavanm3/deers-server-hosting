import mysql from "mysql2/promise";
import { prisma } from "./db";
import { audit } from "./audit";
import { decryptSecret, encryptSecret, generatePassword } from "./crypto";

/**
 * Per-server MySQL databases.
 *
 * Every name is namespaced with the server's short id, and every grant is scoped
 * to exactly one database. A customer holding their own credentials cannot see
 * another customer's data, and cannot reach the admin account that issued them.
 */

export class DatabaseLimitError extends Error {
  constructor(limit: number) {
    super(`This plan allows ${limit} database${limit === 1 ? "" : "s"}.`);
    this.name = "DatabaseLimitError";
  }
}

/** Identifiers are validated, never escaped — anything unexpected is rejected. */
function assertSafeIdentifier(value: string) {
  if (!/^[a-zA-Z0-9_]{1,48}$/.test(value)) {
    throw new Error("Use only letters, numbers and underscores.");
  }
}

async function adminConnection(hostId: string) {
  const host = await prisma.databaseHost.findUniqueOrThrow({ where: { id: hostId } });
  if (!host.enabled) throw new Error("That database host is not accepting new databases.");
  return mysql.createConnection({
    host: host.adminHost,
    port: host.port,
    user: host.adminUser,
    password: decryptSecret(host.adminPasswordEnc),
    multipleStatements: false,
  });
}

export async function createDatabase(serverId: string, rawName: string, actorId?: string | null) {
  assertSafeIdentifier(rawName);

  const server = await prisma.server.findUniqueOrThrow({
    where: { id: serverId },
    include: { plan: true, databases: true, node: true },
  });

  if (server.databases.length >= server.plan.databaseLimit) {
    throw new DatabaseLimitError(server.plan.databaseLimit);
  }

  const host = await prisma.databaseHost.findFirst({
    where: {
      enabled: true,
      OR: [{ nodeId: server.nodeId }, { nodeId: null }],
    },
    // Prefer a host on the same node: the game server then talks to it over the
    // local bridge instead of the public internet.
    orderBy: { nodeId: "desc" },
  });
  if (!host) throw new Error("No database host is available for this server's node.");

  const dbName = `s${server.shortId}_${rawName}`;
  const username = `u${server.shortId}_${rawName}`.slice(0, 32);
  const password = generatePassword();

  const conn = await adminConnection(host.id);
  try {
    await conn.query(`CREATE DATABASE \\`${dbName}\\``);
    await conn.query(`CREATE USER ?@? IDENTIFIED BY ?`, [username, "%", password]);
    // Scoped to this one database. No GRANT OPTION, no global privileges.
    await conn.query(`GRANT ALL PRIVILEGES ON \\`${dbName}\\`.* TO ?@?`, [username, "%"]);
    await conn.query("FLUSH PRIVILEGES");
  } catch (err) {
    // Leave nothing half-created behind.
    await conn.query(`DROP DATABASE IF EXISTS \\`${dbName}\\``).catch(() => undefined);
    await conn.query(`DROP USER IF EXISTS ?@?`, [username, "%"]).catch(() => undefined);
    throw err;
  } finally {
    await conn.end();
  }

  const record = await prisma.serverDatabase.create({
    data: {
      serverId,
      hostId: host.id,
      dbName,
      username,
      passwordEnc: encryptSecret(password),
    },
  });

  await audit({
    actorId,
    action: "database.create",
    targetType: "server",
    targetId: serverId,
    metadata: { dbName, hostId: host.id },
  });

  return {
    id: record.id,
    dbName,
    username,
    password, // returned once, in this response only
    host: host.host,
    port: host.port,
  };
}

/** Credentials are decrypted only for someone already authorised on the server. */
export async function listDatabases(serverId: string) {
  const databases = await prisma.serverDatabase.findMany({
    where: { serverId },
    include: { host: { select: { host: true, port: true } } },
  });

  return databases.map((d) => ({
    id: d.id,
    dbName: d.dbName,
    username: d.username,
    password: decryptSecret(d.passwordEnc),
    host: d.host.host,
    port: d.host.port,
    createdAt: d.createdAt,
  }));
}

export async function rotateDatabasePassword(serverId: string, databaseId: string) {
  const record = await prisma.serverDatabase.findUniqueOrThrow({ where: { id: databaseId } });
  if (record.serverId !== serverId) throw new Error("That database belongs to another server.");

  const password = generatePassword();
  const conn = await adminConnection(record.hostId);
  try {
    await conn.query(`ALTER USER ?@? IDENTIFIED BY ?`, [record.username, "%", password]);
    await conn.query("FLUSH PRIVILEGES");
  } finally {
    await conn.end();
  }

  await prisma.serverDatabase.update({
    where: { id: databaseId },
    data: { passwordEnc: encryptSecret(password) },
  });

  return { password };
}

export async function deleteDatabase(serverId: string, databaseId: string, actorId?: string | null) {
  const record = await prisma.serverDatabase.findUniqueOrThrow({ where: { id: databaseId } });
  if (record.serverId !== serverId) throw new Error("That database belongs to another server.");

  const conn = await adminConnection(record.hostId);
  try {
    await conn.query(`DROP DATABASE IF EXISTS \\`${record.dbName}\\``);
    await conn.query(`DROP USER IF EXISTS ?@?`, [record.username, "%"]);
    await conn.query("FLUSH PRIVILEGES");
  } finally {
    await conn.end();
  }

  await prisma.serverDatabase.delete({ where: { id: databaseId } });
  await audit({
    actorId,
    action: "database.delete",
    targetType: "server",
    targetId: serverId,
    metadata: { dbName: record.dbName },
  });
}

/** Called when a server is deleted, so no orphaned schemas are left behind. */
export async function dropAllDatabases(serverId: string) {
  const databases = await prisma.serverDatabase.findMany({ where: { serverId } });
  for (const d of databases) {
    await deleteDatabase(serverId, d.id).catch((err) =>
      console.error(`[databases] cleanup failed for ${d.dbName}:`, err),
    );
  }
}
