import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ServerNav } from "@/components/server-nav";
import { StartupEditor } from "@/components/startup-editor";

export const dynamic = "force-dynamic";

interface TemplateVariable {
  key: string;
  label: string;
  default?: string;
  editable?: boolean;
}

export default async function StartupPage({ params }: { params: Promise<{ serverId: string }> }) {
  const { serverId } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: { template: true },
  });
  if (!server || (user.role !== "ADMIN" && server.ownerId !== user.id)) redirect("/servers");

  const env = server.environment as Record<string, string>;
  // Template internals (the EULA flag, the memory figure we set ourselves) are
  // not shown — they are not the customer's to change.
  const variables = ((server.template.variables ?? []) as TemplateVariable[])
    .filter((v) => v.editable !== false)
    .map((v) => ({ key: v.key, label: v.label, value: env[v.key] ?? v.default ?? "" }));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{server.name}</h1>
      <ServerNav serverId={serverId} active="/startup" />
      <StartupEditor serverId={serverId} variables={variables} />
    </div>
  );
}
