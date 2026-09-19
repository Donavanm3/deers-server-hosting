import { prisma } from "./db";
import { audit } from "./audit";
import { callAgent, AgentError } from "./agent-rpc";

/**
 * Billing lifecycle.
 *
 * Money and capacity are deliberately decoupled: an unpaid server is suspended
 * (stopped, but its files and its reservation on the node are kept) rather than
 * deleted, so a late payment restores the exact same world. Capacity is only
 * released when the customer cancels or the retention window expires.
 */

const GRACE_DAYS = Number(process.env.BILLING_GRACE_DAYS ?? 3);
const RETENTION_DAYS = Number(process.env.BILLING_RETENTION_DAYS ?? 14);

function invoiceNumber(seq: number): string {
  const year = new Date().getUTCFullYear();
  return `DSH-${year}-${String(seq).padStart(6, "0")}`;
}

async function nextInvoiceNumber(): Promise<string> {
  // Counting rows races when two invoices are created at once, and `number` is
  // unique — so the second insert used to fail outright. Retry on collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const count = await prisma.invoice.count();
    const candidate = invoiceNumber(count + 1 + attempt);
    const taken = await prisma.invoice.findUnique({ where: { number: candidate } });
    if (!taken) return candidate;
  }
  return `DSH-${new Date().getUTCFullYear()}-${Date.now().toString().slice(-6)}`;
}

export async function createInvoiceForServer(serverId: string, periodStart = new Date()) {
  const server = await prisma.server.findUniqueOrThrow({
    where: { id: serverId },
    include: { plan: true },
  });

  const periodEnd = new Date(periodStart);
  periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);

  const dueAt = new Date(periodStart);
  dueAt.setUTCDate(dueAt.getUTCDate() + GRACE_DAYS);

  return prisma.invoice.create({
    data: {
      number: await nextInvoiceNumber(),
      userId: server.ownerId,
      serverId: server.id,
      amountCents: server.plan.monthlyPriceCents,
      currency: server.plan.currency,
      periodStart,
      periodEnd,
      dueAt,
      status: "OPEN",
    },
  });
}

/**
 * Called by the payment webhook. Idempotent on `paymentRef`, so a processor
 * retrying the same event cannot double-credit or double-reactivate.
 */
export async function markInvoicePaid(invoiceId: string, paymentRef: string) {
  const existing = await prisma.invoice.findUnique({ where: { paymentRef } });
  if (existing) return existing;

  const invoice = await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: "PAID", paidAt: new Date(), paymentRef },
  });

  if (invoice.serverId) {
    const server = await prisma.server.findUnique({ where: { id: invoice.serverId } });
    if (server?.suspended) await reactivateServer(server.id);
  }

  await audit({
    action: "invoice.paid",
    targetType: "invoice",
    targetId: invoice.id,
    metadata: { amountCents: invoice.amountCents, paymentRef },
  });

  return invoice;
}

/** Stops the container and blocks power actions, but keeps files and reservation. */
export async function suspendServer(serverId: string, reason: string) {
  const server = await prisma.server.findUniqueOrThrow({
    where: { id: serverId },
    include: { template: true },
  });
  if (server.suspended) return;

  try {
    await callAgent(server.nodeId, {
      op: "server.stop",
      serverId,
      stopCommand: server.template.stopCommand,
      timeoutSeconds: 30,
    });
  } catch (err) {
    // A node being down must not block suspension — the flag is authoritative
    // and the agent reconciles on reconnect.
    if (!(err instanceof AgentError)) throw err;
  }

  await prisma.server.update({
    where: { id: serverId },
    data: { suspended: true, status: "SUSPENDED" },
  });

  await audit({
    action: "server.suspend",
    targetType: "server",
    targetId: serverId,
    metadata: { reason },
  });
}

export async function reactivateServer(serverId: string) {
  await prisma.server.update({
    where: { id: serverId },
    data: { suspended: false, status: "OFFLINE" },
  });
  await audit({ action: "server.reactivate", targetType: "server", targetId: serverId });
}

/**
 * Worker pass. Three jobs in strict order so a server is never billed again
 * after it has been reclaimed.
 */
export async function runBillingCycle() {
  const now = new Date();
  const summary = { invoiced: 0, suspended: 0, reclaimed: 0 };

  // 1. Renew: any active server with no invoice covering the present moment.
  //    This also catches servers that predate invoicing, so nothing runs free.
  const due = await prisma.server.findMany({
    where: {
      suspended: false,
      status: { not: "DELETING" },
      invoices: { none: { periodEnd: { gt: now } } },
    },
    select: { id: true, createdAt: true, invoices: { orderBy: { periodEnd: "desc" }, take: 1 } },
  });
  for (const server of due) {
    // New period starts where the last one ended, so a late worker run does not
    // hand the customer free days.
    const previousEnd = server.invoices[0]?.periodEnd;
    const periodStart = previousEnd && previousEnd > server.createdAt ? previousEnd : now;
    await createInvoiceForServer(server.id, periodStart).catch((err) =>
      console.error(`[billing] invoice failed for ${server.id}:`, err),
    );
    summary.invoiced++;
  }

  // 2. Suspend: open invoices past their due date.
  const overdue = await prisma.invoice.findMany({
    where: { status: "OPEN", dueAt: { lt: now }, serverId: { not: null } },
  });
  for (const invoice of overdue) {
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "OVERDUE" } });
    await suspendServer(invoice.serverId!, `Invoice ${invoice.number} unpaid`).catch((err) =>
      console.error(`[billing] suspend failed for ${invoice.serverId}:`, err),
    );
    summary.suspended++;
  }

  // 3. Reclaim: suspended past the retention window. Capacity goes back to the
  //    pool here and only here, and it is always logged.
  const reclaimBefore = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  const abandoned = await prisma.invoice.findMany({
    where: { status: "OVERDUE", dueAt: { lt: reclaimBefore }, serverId: { not: null } },
  });
  for (const invoice of abandoned) {
    const { deleteServer } = await import("./provisioning");
    await deleteServer(invoice.serverId!).catch((err) =>
      console.error(`[billing] reclaim failed for ${invoice.serverId}:`, err),
    );
    await audit({
      action: "server.reclaim",
      targetType: "server",
      targetId: invoice.serverId!,
      metadata: { invoice: invoice.number, retentionDays: RETENTION_DAYS },
    });
    summary.reclaimed++;
  }

  return summary;
}
