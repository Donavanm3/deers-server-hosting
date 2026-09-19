import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Dashboard. Admins see the fleet; customers see their servers and what is due. */
export default async function DashboardPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  if (user.role === "ADMIN") {
    const [nodes, servers, running, outstanding] = await Promise.all([
      prisma.node.findMany({
        select: {
          status: true,
          enabled: true,
          totalMemoryMb: true,
          reservedMemoryMb: true,
          overheadMemoryMb: true,
        },
      }),
      prisma.server.count(),
      prisma.server.count({ where: { status: "RUNNING" } }),
      prisma.invoice.aggregate({
        where: { status: { in: ["OPEN", "OVERDUE"] } },
        _sum: { amountCents: true },
      }),
    ]);

    const online = nodes.filter((n) => n.status === "ONLINE").length;
    const freeGb =
      nodes
        .filter((n) => n.enabled && n.status === "ONLINE")
        .reduce(
          (sum, n) => sum + Math.max(0, n.totalMemoryMb - n.reservedMemoryMb - n.overheadMemoryMb),
          0,
        ) / 1024;

    return (
      <div className="space-y-8">
        <h1 className="text-2xl font-semibold tracking-tight">Fleet</h1>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Nodes reporting" value={`${online} / ${nodes.length}`} />
          <Stat label="Servers running" value={`${running} / ${servers}`} />
          <Stat label="Memory left to sell" value={`${freeGb.toFixed(1)} GB`} />
          <Stat
            label="Outstanding"
            value={`$${((outstanding._sum.amountCents ?? 0) / 100).toFixed(2)}`}
          />
        </div>
        {freeGb < 16 && (
          <p className="rounded border border-sodium/40 bg-panel p-4 text-sm text-sodium">
            Capacity is getting tight. Add a node before the next few plans sell.
          </p>
        )}
        <div className="flex gap-3">
          <Link href="/admin/nodes" className="rounded bg-sodium px-4 py-2 text-sm font-medium text-ink">
            Manage nodes
          </Link>
          <Link href="/admin/logs" className="rounded border border-line px-4 py-2 text-sm">
            Audit log
          </Link>
        </div>
      </div>
    );
  }

  const [servers, due] = await Promise.all([
    prisma.server.count({ where: { ownerId: user.id } }),
    prisma.invoice.findFirst({
      where: { userId: user.id, status: { in: ["OPEN", "OVERDUE"] } },
      orderBy: { dueAt: "asc" },
    }),
  ]);

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Welcome back, {user.displayName}</h1>
      <div className="grid gap-4 sm:grid-cols-2">
        <Stat label="Your servers" value={String(servers)} />
        <Stat
          label="Next payment"
          value={due ? `$${(due.amountCents / 100).toFixed(2)}` : "Nothing due"}
        />
      </div>
      {due?.status === "OVERDUE" && (
        <p className="rounded border border-down/40 bg-panel p-4 text-sm text-down">
          Invoice {due.number} is overdue. Settle it to keep your server running.
        </p>
      )}
      <Link href="/servers" className="inline-block rounded bg-sodium px-4 py-2 text-sm font-medium text-ink">
        Go to my servers
      </Link>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-line bg-panel p-4">
      <div className="figure text-2xl">{value}</div>
      <div className="mt-1 text-sm text-muted">{label}</div>
    </div>
  );
}
