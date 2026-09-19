import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ServerNav } from "@/components/server-nav";
import { BackupManager } from "@/components/backup-manager";

export const dynamic = "force-dynamic";

export default async function BackupsPage({ params }: { params: Promise<{ serverId: string }> }) {
  const { serverId } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: { plan: true, backups: true, schedules: true },
  });
  if (!server || (user.role !== "ADMIN" && server.ownerId !== user.id)) redirect("/servers");

  const usedMb = Math.round(
    server.backups.reduce((sum, b) => sum + Number(b.bytes), 0) / 1024 / 1024,
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{server.name}</h1>
      <ServerNav serverId={serverId} active="/backups" />
      <BackupManager
        serverId={serverId}
        usedMb={usedMb}
        limitMb={server.plan.backupMb}
        schedule={
          server.schedules[0]
            ? {
                minuteUtc: server.schedules[0].minuteUtc,
                keepCount: server.schedules[0].keepCount,
                enabled: server.schedules[0].enabled,
              }
            : null
        }
        initial={server.backups
          .map((b) => ({
            id: b.id,
            name: b.name,
            bytes: Number(b.bytes),
            completed: b.completed,
            createdAt: b.createdAt.toISOString(),
          }))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))}
      />
    </div>
  );
}
