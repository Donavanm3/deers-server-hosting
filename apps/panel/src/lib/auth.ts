import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { prisma } from "./db";

const SESSION_COOKIE = "deers_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: "CUSTOMER" | "ADMIN";
};

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return token;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  jar.delete(SESSION_COOKIE);
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date()) return null;
  const { user } = session;
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
}

export class AuthError extends Error {
  constructor(public status: 401 | 403, message: string) {
    super(message);
  }
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new AuthError(401, "Sign in to continue.");
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "ADMIN") throw new AuthError(403, "Administrator access required.");
  return user;
}

export type ServerPermission =
  | "console.view"
  | "console.command"
  | "power.start"
  | "power.stop"
  | "files.read"
  | "files.write"
  | "files.delete"
  | "backups.read"
  | "backups.create"
  | "settings.write";

/**
 * Every server-scoped route goes through this. It is the only place ownership is
 * decided, so a customer can never reach another customer's container — and no
 * route ever receives a node id or agent token from the client.
 */
export async function requireServerAccess(
  serverId: string,
  permission: ServerPermission,
) {
  const user = await requireUser();
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: { subusers: true, node: { select: { id: true, name: true, status: true } } },
  });
  if (!server) throw new AuthError(403, "Server not found.");

  if (user.role === "ADMIN") return { user, server };
  if (server.ownerId === user.id) return { user, server };

  const sub = server.subusers.find((s) => s.userId === user.id);
  if (sub && sub.permissions.includes(permission)) return { user, server };

  throw new AuthError(403, "You do not have access to this server.");
}

export function verifyPassword(plain: string, hash: string) {
  return bcrypt.compare(plain, hash);
}

export function hashPassword(plain: string) {
  return bcrypt.hash(plain, 12);
}

/** Constant-time compare for agent tokens on the gateway. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
