import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { createSession, verifyPassword } from "@/lib/auth";
import { redis } from "@/lib/redis";
import { audit } from "@/lib/audit";
import { fail } from "@/app/api/_helpers";

const schema = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(req: Request) {
  try {
    const { email, password } = schema.parse(await req.json());
    const ip = req.headers.get("x-forwarded-for") ?? "unknown";

    // Rate limit per IP: ten attempts per fifteen minutes.
    const key = `login:attempts:${ip}`;
    const attempts = await redis.incr(key);
    if (attempts === 1) await redis.expire(key, 900);
    if (attempts > 10) {
      return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    // Same message either way, so the response cannot be used to enumerate accounts.
    const invalid = NextResponse.json({ error: "That email and password do not match." }, { status: 401 });
    if (!user) return invalid;
    if (!(await verifyPassword(password, user.passwordHash))) {
      await audit({ actorId: user.id, action: "auth.login_failed", targetType: "user", targetId: user.id, ip });
      return invalid;
    }

    await redis.del(key);
    await createSession(user.id);
    await audit({ actorId: user.id, action: "auth.login", targetType: "user", targetId: user.id, ip });

    return NextResponse.json({ user: { id: user.id, displayName: user.displayName, role: user.role } });
  } catch (err) {
    return fail(err);
  }
}
