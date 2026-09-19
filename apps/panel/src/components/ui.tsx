import Link from "next/link";
import type { ReactNode } from "react";

/** Shared primitives, so every page states status and hierarchy the same way. */

export function Panel({
  title,
  description,
  action,
  children,
  padded = true,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  padded?: boolean;
}) {
  return (
    <section className="rounded-[10px] border border-line-soft bg-surface">
      {(title || action) && (
        <header className="flex flex-wrap items-center gap-3 border-b border-line-soft px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {action && <div className="ml-auto shrink-0">{action}</div>}
        </header>
      )}
      <div className={padded ? "p-5" : undefined}>{children}</div>
    </section>
  );
}

const STATE = {
  up: { dot: "var(--color-mint)", bg: "var(--color-mint-dim)", fg: "var(--color-mint)" },
  down: { dot: "var(--color-coral)", bg: "var(--color-coral-dim)", fg: "var(--color-coral)" },
  busy: { dot: "var(--color-gold)", bg: "#37301c", fg: "var(--color-gold)" },
  idle: { dot: "var(--color-muted)", bg: "var(--color-raised)", fg: "var(--color-muted)" },
} as const;

export function statusTone(status: string, suspended = false): keyof typeof STATE {
  if (suspended) return "busy";
  if (status === "RUNNING") return "up";
  if (["STARTING", "STOPPING", "PROVISIONING", "INSTALLING", "DELETING"].includes(status)) return "busy";
  if (["CRASHED", "FAILED", "UNREACHABLE", "OFFLINE"].includes(status)) return "down";
  return "idle";
}

export function Status({ tone, children }: { tone: keyof typeof STATE; children: ReactNode }) {
  const t = STATE[tone];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{ background: t.bg, color: t.fg }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.dot }} aria-hidden />
      {children}
    </span>
  );
}

/** A capacity bar. Fills coral past 90% so a node about to run dry is obvious. */
export function Gauge({ used, total, label }: { used: number; total: number; label: string }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="tnum text-sm">{label}</span>
        <span className="tnum text-xs text-muted">{Math.round(pct)}%</span>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-raised">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${pct}%`, background: pct > 90 ? "var(--color-coral)" : "var(--color-mint)" }}
        />
      </div>
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="rounded-[10px] border border-dashed border-line px-6 py-14 text-center">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ServerTabs({ serverId, active }: { serverId: string; active: string }) {
  const tabs = [
    { id: "console", label: "Console", href: `/servers/${serverId}` },
    { id: "settings", label: "Settings", href: `/servers/${serverId}/settings` },
    { id: "mods", label: "Mods", href: `/servers/${serverId}/mods` },
    { id: "files", label: "Files", href: `/servers/${serverId}/files` },
    { id: "backups", label: "Backups", href: `/servers/${serverId}/backups` },
  ];

  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-line-soft" aria-label="Server sections">
      {tabs.map((tab) => {
        const current = tab.id === active;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            aria-current={current ? "page" : undefined}
            className={`-mb-px whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm ${
              current
                ? "border-gold text-text"
                : "border-transparent text-muted hover:border-line hover:text-text"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function gb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;
  return `${mb} MB`;
}
