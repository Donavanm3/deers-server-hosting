import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: "var(--color-down)",
  WARNING: "var(--color-sodium)",
  INFO: "var(--color-muted)",
};

export default async function AlertsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect("/servers");

  const alerts = await prisma.alert.findMany({
    where: { resolvedAt: null },
    orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
        <p className="mt-1 text-sm text-muted">
          Open issues only. Anything that recovers clears itself within a few minutes.
        </p>
      </div>

      {alerts.length === 0 ? (
        <div className="rounded border border-dashed border-line p-12 text-center">
          <p className="text-muted">Nothing is wrong right now.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {alerts.map((a) => (
            <div key={a.id} className="rounded border border-line bg-panel p-4">
              <div className="flex items-center gap-2">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: SEVERITY_COLOR[a.severity] }}
                  aria-hidden
                />
                <span className="font-medium">{a.title}</span>
                <span className="figure ml-auto text-xs text-muted">
                  since {a.createdAt.toISOString().replace("T", " ").slice(0, 16)}
                </span>
              </div>
              <p className="mt-2 text-sm text-muted">{a.detail}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
