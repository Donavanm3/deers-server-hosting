import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LogsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect("/servers");

  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { actor: { select: { email: true } } },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-muted">Every administrative and destructive action, newest first.</p>
      </div>

      <div className="overflow-hidden rounded border border-line">
        <table className="w-full text-left text-sm">
          <thead className="bg-panel text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">When</th>
              <th className="px-4 py-3 font-medium">Who</th>
              <th className="px-4 py-3 font-medium">Action</th>
              <th className="px-4 py-3 font-medium">Target</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id} className="border-t border-line">
                <td className="figure px-4 py-2 text-xs text-muted">
                  {l.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                </td>
                <td className="px-4 py-2">{l.actor?.email ?? "system"}</td>
                <td className="px-4 py-2">{l.action}</td>
                <td className="figure px-4 py-2 text-xs text-muted">
                  {l.targetType}/{l.targetId.slice(0, 8)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
