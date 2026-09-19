import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { Console } from "@/components/console";
import { ServerTabs, gb } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ServerPage({ params }: { params: Promise<{ serverId: string }> }) {
  const { serverId } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: {
      plan: true,
      template: true,
      subusers: { select: { userId: true } },
      allocations: { where: { primary: true }, take: 1 },
      node: { select: { location: true } },
    },
  });

  // Re-checked here as well as in the API: a customer must never learn that
  // another customer's server exists.
  const allowed =
    server &&
    (user.role === "ADMIN" ||
      server.ownerId === user.id ||
      server.subusers.some((s) => s.userId === user.id));
  if (!allowed) redirect("/servers");

  const address = server.allocations[0]
    ? `${server.allocations[0].ip}:${server.allocations[0].port}`
    : "Assigning an address";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl">{server.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {server.template.name} on the {server.plan.name} plan, hosted in {server.node.location}
          </p>
        </div>
        <dl className="flex gap-6 text-sm">
          <div>
            <dt className="text-xs text-muted">Connect with</dt>
            <dd className="tnum">{address}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Memory</dt>
            <dd className="tnum">{gb(server.memoryMb)}</dd>
          </div>
        </dl>
      </div>

      <ServerTabs serverId={serverId} active="console" />
      <Console serverId={server.id} initialStatus={server.status} />
    </div>
  );
}
