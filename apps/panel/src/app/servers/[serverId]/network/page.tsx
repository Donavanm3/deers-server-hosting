import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ServerNav } from "@/components/server-nav";

export const dynamic = "force-dynamic";

export default async function NetworkPage({ params }: { params: Promise<{ serverId: string }> }) {
  const { serverId } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: { allocations: { orderBy: { port: "asc" } }, plan: true },
  });
  if (!server || (user.role !== "ADMIN" && server.ownerId !== user.id)) redirect("/servers");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{server.name}</h1>
      <ServerNav serverId={serverId} active="/network" />

      <div>
        <h2 className="text-lg font-medium">Addresses</h2>
        <p className="mt-1 text-sm text-muted">
          Give the primary address to your players. Your plan includes{" "}
          {server.plan.allocationLimit} address
          {server.plan.allocationLimit === 1 ? "" : "es"}.
        </p>
      </div>

      <div className="overflow-hidden rounded border border-line">
        <table className="w-full text-left text-sm">
          <thead className="bg-panel text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Address</th>
              <th className="px-4 py-3 font-medium">Role</th>
            </tr>
          </thead>
          <tbody>
            {server.allocations.map((a) => (
              <tr key={a.id} className="border-t border-line">
                <td className="figure px-4 py-2">
                  {a.ip}:{a.port}
                </td>
                <td className="px-4 py-2 text-muted">{a.primary ? "Primary" : "Additional"}</td>
              </tr>
            ))}
            {server.allocations.length === 0 && (
              <tr>
                <td colSpan={2} className="px-4 py-6 text-muted">
                  No address assigned yet. This resolves within a minute of provisioning.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
