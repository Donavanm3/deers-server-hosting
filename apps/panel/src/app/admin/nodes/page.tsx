import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { isNodeConnected } from "@/lib/agent-rpc";
import { NodeRow } from "@/components/node-row";

export const dynamic = "force-dynamic";

/** Every figure below is read from Postgres and the agent's last heartbeat. */
export default async function NodesPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect("/servers");

  const nodes = await prisma.node.findMany({
    orderBy: [{ enabled: "desc" }, { name: "asc" }],
    include: { _count: { select: { servers: true } } },
  });

  const rows = await Promise.all(
    nodes.map(async (n) => ({
      id: n.id,
      name: n.name,
      hostname: n.hostname,
      location: n.location,
      type: n.type,
      status: n.status,
      enabled: n.enabled,
      connected: await isNodeConnected(n.id),
      agentVersion: n.agentVersion,
      lastHeartbeat: n.lastHeartbeat?.toISOString() ?? null,
      servers: n._count.servers,
      memory: {
        total: n.totalMemoryMb,
        reserved: n.reservedMemoryMb,
        available: n.totalMemoryMb - n.reservedMemoryMb - n.overheadMemoryMb,
      },
      disk: {
        total: n.totalDiskMb,
        reserved: n.reservedDiskMb,
        available: n.totalDiskMb - n.reservedDiskMb - n.overheadDiskMb,
      },
      cpu: {
        total: n.totalCpuCores,
        reserved: n.reservedCpuCores,
        available: n.totalCpuCores - n.reservedCpuCores,
      },
    })),
  );

  const fleet = rows.reduce(
    (acc, n) => ({
      memory: acc.memory + Math.max(0, n.memory.available),
      servers: acc.servers + n.servers,
      online: acc.online + (n.connected ? 1 : 0),
    }),
    { memory: 0, servers: 0, online: 0 },
  );

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Nodes</h1>
          <p className="mt-1 text-sm text-muted">
            {fleet.online} of {rows.length} reporting in · {fleet.servers} servers placed ·{" "}
            <span className="figure">{(fleet.memory / 1024).toFixed(1)} GB</span> free to sell
          </p>
        </div>
        <Link
          href="/admin/nodes/new"
          className="rounded bg-sodium px-4 py-2 text-sm font-medium text-ink hover:bg-sodium/90"
        >
          Add node
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-line p-10 text-center">
          <p className="text-muted">No nodes yet. Add one to start placing servers.</p>
          <Link href="/admin/nodes/new" className="mt-3 inline-block text-sodium underline">
            Add your first node
          </Link>
        </div>
      ) : (
        <div className="overflow-hidden rounded border border-line">
          <table className="w-full text-left text-sm">
            <thead className="bg-panel text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Node</th>
                <th className="px-4 py-3 font-medium">Memory</th>
                <th className="px-4 py-3 font-medium">Storage</th>
                <th className="px-4 py-3 font-medium">CPU</th>
                <th className="px-4 py-3 font-medium">Servers</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => (
                <NodeRow key={n.id} node={n} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
