import Link from "next/link";

const TABS = [
  { href: "", label: "Console" },
  { href: "/files", label: "Files" },
  { href: "/backups", label: "Backups" },
  { href: "/startup", label: "Startup" },
  { href: "/network", label: "Network" },
];

export function ServerNav({ serverId, active }: { serverId: string; active: string }) {
  return (
    <nav className="flex gap-1 border-b border-line">
      {TABS.map((tab) => {
        const isActive = tab.href === active;
        return (
          <Link
            key={tab.label}
            href={`/servers/${serverId}${tab.href}`}
            className={`border-b-2 px-4 py-2 text-sm ${
              isActive
                ? "border-sodium text-sodium"
                : "border-transparent text-muted hover:text-text"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
