"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Backup {
  id: string;
  name: string;
  bytes: number;
  completed: boolean;
  createdAt: string;
}

function size(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function BackupManager({
  serverId,
  usedMb,
  limitMb,
  initial,
  schedule,
}: {
  serverId: string;
  usedMb: number;
  limitMb: number;
  initial: Backup[];
  schedule: { minuteUtc: number; keepCount: number; enabled: boolean } | null;
}) {
  const router = useRouter();
  const [backups, setBackups] = useState(initial);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch(`/api/servers/${serverId}/backups`);
    if (res.ok) setBackups((await res.json()).backups);
    router.refresh();
  }

  async function create() {
    setBusy("create");
    setError(null);
    const res = await fetch(`/api/servers/${serverId}/backups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create", name: name || `Manual ${new Date().toISOString().slice(0, 16)}` }),
    });
    setBusy(null);
    if (!res.ok) return setError((await res.json()).error);
    setName("");
    await refresh();
  }

  async function restore(backup: Backup) {
    // Restoring stops the server and replaces the world, so make that explicit.
    if (!confirm(`Restore "${backup.name}"? The server stops and its current files are replaced.`)) return;
    setBusy(backup.id);
    setError(null);
    const res = await fetch(`/api/servers/${serverId}/backups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "restore", backupId: backup.id }),
    });
    setBusy(null);
    if (!res.ok) return setError((await res.json()).error);
    await refresh();
  }

  async function remove(backup: Backup) {
    if (!confirm(`Delete "${backup.name}"? This cannot be undone.`)) return;
    setBusy(backup.id);
    const res = await fetch(`/api/servers/${serverId}/backups`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backupId: backup.id }),
    });
    setBusy(null);
    if (!res.ok) return setError((await res.json()).error);
    await refresh();
  }

  const full = limitMb > 0 && usedMb >= limitMb;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <div className="figure text-sm">
            {usedMb} MB {limitMb > 0 ? `of ${limitMb} MB` : "used"}
          </div>
          {schedule?.enabled && (
            <p className="mt-1 text-xs text-muted">
              Automatic backup daily at{" "}
              {String(Math.floor(schedule.minuteUtc / 60)).padStart(2, "0")}:
              {String(schedule.minuteUtc % 60).padStart(2, "0")} UTC, keeping {schedule.keepCount}.
            </p>
          )}
        </div>
        <div className="ml-auto flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Backup name"
            className="rounded border border-line bg-panel px-3 py-2 text-sm"
          />
          <button
            onClick={create}
            disabled={busy === "create" || full}
            className="rounded bg-sodium px-4 py-2 text-sm font-medium text-ink disabled:opacity-50"
          >
            {busy === "create" ? "Backing up…" : "Back up now"}
          </button>
        </div>
      </div>

      {full && (
        <p className="text-sm text-sodium">
          Backup storage is full. Delete an old backup or move to a larger plan.
        </p>
      )}
      {error && <p className="text-sm text-down">{error}</p>}

      <div className="overflow-hidden rounded border border-line">
        <table className="w-full text-left text-sm">
          <thead className="bg-panel text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Size</th>
              <th className="px-4 py-3 font-medium">Taken</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {backups.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-muted">
                  No backups yet. Take one before you try a new mod or plugin.
                </td>
              </tr>
            )}
            {backups.map((b) => (
              <tr key={b.id} className="border-t border-line">
                <td className="px-4 py-2">
                  {b.name}
                  {!b.completed && <span className="ml-2 text-xs text-sodium">in progress</span>}
                </td>
                <td className="figure px-4 py-2">{size(b.bytes)}</td>
                <td className="figure px-4 py-2 text-xs text-muted">
                  {b.createdAt.replace("T", " ").slice(0, 16)}
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    onClick={() => restore(b)}
                    disabled={!b.completed || busy === b.id}
                    className="mr-3 text-xs text-sodium disabled:opacity-40"
                  >
                    Restore
                  </button>
                  <button
                    onClick={() => remove(b)}
                    disabled={busy === b.id}
                    className="text-xs text-muted hover:text-down disabled:opacity-40"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
