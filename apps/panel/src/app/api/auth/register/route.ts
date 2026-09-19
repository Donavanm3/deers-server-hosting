import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { createSession, hashPassword } from "@/lib/auth";
import { fail } from "@/app/api/_helpers";

const schema = z.object({
  email: z.string().email(),
  displayName: z.string().min(2).max(64),
  password: z.string().min(12, "Use at least 12 characters."),
});

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      return NextResponse.json({ error: "That email is already registered." }, { status: 409 });
    }

    const user = await prisma.user.create({
      data: {
        email: body.email,
        displayName: body.displayName,
        passwordHash: await hashPassword(body.password),
        role: "CUSTOMER", // never settable from the request body
      },
    });

    await createSession(user.id);
    return NextResponse.json({ user: { id: user.id, displayName: user.displayName } }, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}
