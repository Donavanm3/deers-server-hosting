import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ServerTabs } from "@/components/ui";
import { SettingsForm } from "@/components/settings-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ params }: { params: Promise<{ serverId: string }> }) {
  const { serverId } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: { subusers: { select: { userId: true } }, template: true },
  });
  const allowed =
    server &&
    (user.role === "ADMIN" ||
      server.ownerId === user.id ||
      server.subusers.some((s) => s.userId === user.id));
  if (!allowed) redirect("/servers");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl">{server.name}</h1>
        <p className="mt-1 text-sm text-muted">Game settings for {server.template.name}</p>
      </div>
      <ServerTabs serverId={serverId} active="settings" />
      <SettingsForm serverId={serverId} />
    </div>
  );
}
