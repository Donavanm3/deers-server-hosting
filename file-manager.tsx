"use client";

import { useCallback, useEffect, useState } from "react";
import type { FileEntry } from "@deers/shared/protocol";

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FileManager({ serverId }: { serverId: string }) {
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [editing, setEditing] = useState<{ path: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (target: string) => {
      setBusy(true);
      setError(null);
      const res = await fetch(`/api/servers/${serverId}/files?path=${encodeURIComponent(target)}`);
      setBusy(false);
      if (!res.ok) return setError((await res.json()).error);
      const data = await res.json();
      setEntries(data.entries);
      setPath(data.path);
    },
    [serverId],
  );

  useEffect(() => {
    void load("/");
  }, [load]);

  async function open(entry: FileEntry) {
    if (entry.directory) return load(entry.path);
    if (entry.sizeBytes > 2_000_000) {
      return setError("That file is too large to edit here. Use SFTP instead.");
    }
    const res = await fetch(`/api/servers/${serverId}/files?file=${encodeURIComponent(entry.path)}`);
    if (!res.ok) return setError((await res.json()).error);
    setEditing({ path: entry.path, content: (await res.json()).content });
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    const res = await fetch(`/api/servers/${serverId}/files`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(editing),
    });
    setBusy(false);
    if (!res.ok) return setError((await res.json()).error);
    setEditing(null);
    void load(path);
  }

  async function remove(entry: FileEntry) {
    if (!confirm(`Delete ${entry.name}? This cannot be undone.`)) return;
    const res = await fetch(`/api/servers/${serverId}/files`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: [entry.path] }),
    });
    if (!res.ok) return setError((await res.json()).error);
    void load(path);
  }

  if (editing) {
    return (
      <section className="rounded border border-line bg-panel">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <span className="figure text-sm">{editing.path}</span>
          <div className="ml-auto flex gap-2">
            <button onClick={() => setEditing(null)} className="rounded border border-line px-3 py-1.5 text-xs">
              Discard
            </button>
            <button onClick={save} disabled={busy} className="rounded bg-sodium px-3 py-1.5 text-xs font-medium text-ink">
              {busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
        <textarea
          value={editing.content}
          onChange={(e) => setEditing({ ...editing, content: e.target.value })}
          spellCheck={false}
          className="h-[28rem] w-full resize-none bg-ink px-4 py-3 font-mono text-xs"
        />
      </section>
    );
  }

  const parent = path === "/" ? null : path.split("/").slice(0, -1).join("/") || "/";

  return (
    <section className="rounded border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="figure text-sm text-muted">{path}</span>
        {busy && <span className="text-xs text-muted">Loading…</span>}
      </div>
      {error && <p className="border-b border-line px-4 py-2 text-sm text-down">{error}</p>}
      <table className="w-full text-left text-sm">
        <tbody>
          {parent !== null && (
            <tr className="border-b border-line">
              <td colSpan={3} className="px-4 py-2">
                <button onClick={() => load(parent)} className="text-sodium">Up one level</button>
              </td>
            </tr>
          )}
          {entries.map((entry) => (
            <tr key={entry.path} className="border-b border-line last:border-0">
              <td className="px-4 py-2">
                <button onClick={() => open(entry)} className="hover:text-sodium">
                  {entry.directory ? `${entry.name}/` : entry.name}
                </button>
              </td>
              <td className="figure px-4 py-2 text-xs text-muted">
                {entry.directory ? "" : size(entry.sizeBytes)}
              </td>
              <td className="px-4 py-2 text-right">
                <button onClick={() => remove(entry)} className="text-xs text-muted hover:text-down">
                  Delete
                </button>
              </td>
            </tr>
          ))}
          {entries.length === 0 && !busy && (
            <tr>
              <td colSpan={3} className="px-4 py-8 text-center text-muted">
                This folder is empty.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
