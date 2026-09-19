import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { FileManager } from "@/components/file-manager";

export const dynamic = "force-dynamic";

export default async function FilesPage({ params }: { params: Promise<{ serverId: string }> }) {
  const { serverId } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: { subusers: { select: { userId: true } } },
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
        <h1 className="text-2xl font-semibold tracking-tight">Files</h1>
        <p className="mt-1 text-sm text-muted">
          {server.name} · changes to configuration files apply when the server next starts
        </p>
      </div>
      <FileManager serverId={serverId} />
    </div>
  );
}
