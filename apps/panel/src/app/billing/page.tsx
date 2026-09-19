import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

function money(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export default async function BillingPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const invoices = await prisma.invoice.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { server: { select: { name: true } } },
  });

  const outstanding = invoices
    .filter((i) => i.status === "OPEN" || i.status === "OVERDUE")
    .reduce((sum, i) => sum + i.amountCents, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="mt-1 text-sm text-muted">
          {outstanding > 0
            ? `${money(outstanding, "USD")} outstanding. Servers are suspended three days after the due date.`
            : "Nothing outstanding."}
        </p>
      </div>

      {invoices.length === 0 ? (
        <p className="rounded border border-dashed border-line p-10 text-center text-muted">
          Invoices appear here once you have a server.
        </p>
      ) : (
        <div className="overflow-hidden rounded border border-line">
          <table className="w-full text-left text-sm">
            <thead className="bg-panel text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Invoice</th>
                <th className="px-4 py-3 font-medium">Server</th>
                <th className="px-4 py-3 font-medium">Period</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id} className="border-t border-line">
                  <td className="figure px-4 py-2">{i.number}</td>
                  <td className="px-4 py-2">{i.server?.name ?? "—"}</td>
                  <td className="figure px-4 py-2 text-xs text-muted">
                    {i.periodStart.toISOString().slice(0, 10)} to {i.periodEnd.toISOString().slice(0, 10)}
                  </td>
                  <td className="figure px-4 py-2">{money(i.amountCents, i.currency)}</td>
                  <td className="px-4 py-2">
                    <span
                      style={{
                        color:
                          i.status === "PAID"
                            ? "var(--color-live)"
                            : i.status === "OVERDUE"
                              ? "var(--color-down)"
                              : "var(--color-sodium)",
                      }}
                    >
                      {i.status.toLowerCase()}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
