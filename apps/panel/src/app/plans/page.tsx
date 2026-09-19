import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { PlanPicker } from "@/components/plan-picker";

export const dynamic = "force-dynamic";

export default async function PlansPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const plans = await prisma.plan.findMany({
    where: { visible: true },
    orderBy: { monthlyPriceCents: "asc" },
    include: { template: { select: { name: true } } },
  });

  // Locations with a node that can actually take a server right now. Offering a
  // location we cannot fill is how you get a failed checkout.
  const nodes = await prisma.node.findMany({
    where: { status: "ONLINE", enabled: true },
    select: { location: true },
    distinct: ["location"],
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Choose a plan</h1>
        <p className="mt-1 text-sm text-muted">Your server is ready about a minute after checkout.</p>
      </div>
      <PlanPicker
        locations={nodes.map((n) => n.location)}
        plans={plans.map((p) => ({
          id: p.id,
          name: p.name,
          game: p.template?.name ?? "Any game",
          memoryMb: p.memoryMb,
          diskMb: p.diskMb,
          cpuCores: p.cpuCores,
          backupMb: p.backupMb,
          priceCents: p.monthlyPriceCents,
        }))}
      />
    </div>
  );
}
