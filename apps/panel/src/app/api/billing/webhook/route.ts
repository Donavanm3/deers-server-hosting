import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { markInvoicePaid } from "@/lib/billing";
import { audit } from "@/lib/audit";

/**
 * Payment webhook. The body is verified against a shared secret before anything
 * is parsed, and `markInvoicePaid` is idempotent on the payment reference, so a
 * processor retrying the same event is harmless.
 *
 * Swap the signature scheme for your processor's; the important parts are the
 * raw-body read, the constant-time compare, and never trusting the amount in
 * the payload over the invoice in the database.
 */
const schema = z.object({
  event: z.literal("payment.completed"),
  invoiceId: z.string().uuid(),
  paymentRef: z.string().min(4),
  amountCents: z.number().int().positive(),
});

export async function POST(req: Request) {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[billing] PAYMENT_WEBHOOK_SECRET is not set; refusing webhook");
    return NextResponse.json({ error: "Webhooks are not configured." }, { status: 503 });
  }

  const raw = await req.text();
  const provided = req.headers.get("x-deers-signature") ?? "";
  const expected = createHmac("sha256", secret).update(raw).digest("hex");

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  const body = schema.safeParse(JSON.parse(raw));
  if (!body.success) return NextResponse.json({ error: "Unrecognised event." }, { status: 400 });

  try {
    const invoice = await markInvoicePaid(body.data.invoiceId, body.data.paymentRef);

    // Underpayment leaves the invoice paid but flagged for a human.
    if (body.data.amountCents < invoice.amountCents) {
      await audit({
        action: "invoice.underpaid",
        targetType: "invoice",
        targetId: invoice.id,
        metadata: { expected: invoice.amountCents, received: body.data.amountCents },
      });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[billing] webhook failed:", err);
    // A 500 asks the processor to retry, which is what we want.
    return NextResponse.json({ error: "Could not record the payment." }, { status: 500 });
  }
}
