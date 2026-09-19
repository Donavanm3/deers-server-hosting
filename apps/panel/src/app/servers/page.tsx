import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { Empty, Status, statusTone, gb } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ServersPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const servers = await prisma.server.findMany({
    where: { OR: [{ ownerId: user.id }, { subusers: { some: { userId: user.id } } }] },
    orderBy: { createdAt: "asc" },
    include: {
      plan: { select: { name: true } },
      template: { select: { name: true } },
      node: { select: { location: true } },
      allocations: { where: { primary: true }, take: 1 },
    },
  });

  if (servers.length === 0) {
    return (
      <Empty
        title="No servers yet"
        body="Choose a plan and your world will be running in about a minute."
        action={
          <Link href="/plans" className="rounded-md bg-gold px-4 py-2 text-sm font-semibold text-bg">
            Choose a plan
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-2xl">Your servers</h1>
        <Link
          href="/plans"
          className="rounded-md border border-line px-3.5 py-2 text-sm hover:border-gold hover:text-gold"
        >
          Add another
        </Link>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {servers.map((s) => {
          const address = s.allocations[0]
            ? `${s.allocations[0].ip}:${s.allocations[0].port}`
            : "Assigning an address";
          return (
            <Link
              key={s.id}
              href={`/servers/${s.id}`}
              className="group rounded-[10px] border border-line-soft bg-surface p-5 hover:border-line"
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="truncate text-base font-semibold group-hover:text-gold">{s.name}</h2>
                <Status tone={statusTone(s.status, s.suspended)}>
                  {s.suspended ? "Suspended" : s.status.toLowerCase()}
                </Status>
              </div>

              <p className="mt-1 text-sm text-muted">
                {s.template.name} on the {s.plan.name} plan, hosted in {s.node.location}
              </p>

              <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-muted">Connect with</dt>
                  <dd className="tnum">{address}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Memory</dt>
                  <dd className="tnum">{gb(s.memoryMb)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Storage</dt>
                  <dd className="tnum">{gb(s.diskMb)}</dd>
                </div>
              </dl>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
