import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminServersPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect("/servers");

  const servers = await prisma.server.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      owner: { select: { email: true } },
      node: { select: { name: true } },
      plan: { select: { name: true } },
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">All servers</h1>
        <p className="mt-1 text-sm text-muted">{servers.length} shown, newest first</p>
      </div>

      <div className="overflow-hidden rounded border border-line">
        <table className="w-full text-left text-sm">
          <thead className="bg-panel text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Server</th>
              <th className="px-4 py-3 font-medium">Owner</th>
              <th className="px-4 py-3 font-medium">Node</th>
              <th className="px-4 py-3 font-medium">Plan</th>
              <th className="px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {servers.map((s) => (
              <tr key={s.id} className="border-t border-line">
                <td className="px-4 py-2">
                  <Link href={`/servers/${s.id}`} className="hover:text-sodium">{s.name}</Link>
                </td>
                <td className="px-4 py-2 text-muted">{s.owner.email}</td>
                <td className="px-4 py-2">{s.node.name}</td>
                <td className="px-4 py-2 text-muted">{s.plan.name}</td>
                <td className="px-4 py-2">
                  <span
                    style={{
                      color:
                        s.status === "RUNNING"
                          ? "var(--color-live)"
                          : s.suspended
                            ? "var(--color-sodium)"
                            : "var(--color-muted)",
                    }}
                  >
                    {s.suspended ? "suspended" : s.status.toLowerCase()}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
