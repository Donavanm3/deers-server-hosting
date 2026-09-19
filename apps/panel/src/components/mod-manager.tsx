"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Panel, Empty } from "./ui";

interface Slot { id: string; dir: string; label: string; extensions: string[] }
interface Item { name: string; path: string; sizeBytes: number }
interface SearchHit {
  id: string;
  title: string;
  description: string;
  downloads: number;
  iconUrl: string | null;
}

function size(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export function ModManager({ serverId }: { serverId: string }) {
  const [slots, setSlots] = useState<Slot[]>([]);
  const [installed, setInstalled] = useState<{ slot: Slot; items: Item[] }[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/servers/${serverId}/mods`);
    setLoading(false);
    if (!res.ok) return setError((await res.json()).error);
    const data = await res.json();
    setSlots(data.slots);
    setInstalled(data.installed);
  }, [serverId]);

  useEffect(() => { void load(); }, [load]);

  async function search() {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    const res = await fetch(`/api/servers/${serverId}/mods?search=${encodeURIComponent(query)}`);
    setSearching(false);
    if (!res.ok) return setError((await res.json()).error);
    setHits((await res.json()).results);
  }

  async function install(projectId: string, title: string) {
    setBusy(projectId);
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/servers/${serverId}/mods`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "modrinth", projectId }),
    });
    setBusy(null);
    if (!res.ok) return setError((await res.json()).error);
    setNotice(`${title} installed. Restart the server to load it.`);
    void load();
  }

  async function upload(slotId: string, file: File) {
    setBusy("upload");
    setError(null);
    const form = new FormData();
    form.set("file", file);
    form.set("slotId", slotId);
    const res = await fetch(`/api/servers/${serverId}/mods`, { method: "POST", body: form });
    setBusy(null);
    if (!res.ok) return setError((await res.json()).error);
    setNotice(`${file.name} uploaded. Restart the server to load it.`);
    void load();
  }

  async function remove(slotId: string, filename: string) {
    if (!confirm(`Remove ${filename}?`)) return;
    setBusy(filename);
    const res = await fetch(`/api/servers/${serverId}/mods`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slotId, filename }),
    });
    setBusy(null);
    if (!res.ok) return setError((await res.json()).error);
    void load();
  }

  if (loading) return <Panel><p className="text-sm text-muted">Checking what this server can load…</p></Panel>;

  if (slots.length === 0) {
    return (
      <Empty
        title="This server runs vanilla Minecraft"
        body="Vanilla loads no mods or plugins. Switch the server type to Paper or Fabric on the startup settings, restart, and this page will open up."
      />
    );
  }

  return (
    <div className="space-y-5">
      {error && <p className="rounded-md bg-coral-dim px-3 py-2 text-sm text-coral">{error}</p>}
      {notice && <p className="rounded-md bg-mint-dim px-3 py-2 text-sm text-mint">{notice}</p>}

      <Panel title="Find something to add" description="Searches Modrinth for builds that match your server.">
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="Try: worldedit, chunky, dynmap"
            className="flex-1 rounded-md border border-line bg-bg px-3 py-2 text-sm"
          />
          <button
            onClick={search}
            disabled={searching}
            className="rounded-md bg-gold px-4 py-2 text-sm font-semibold text-bg disabled:opacity-40"
          >
            {searching ? "Searching…" : "Search"}
          </button>
        </div>

        {hits.length > 0 && (
          <ul className="mt-4 space-y-2">
            {hits.map((hit) => (
              <li key={hit.id} className="flex items-start gap-3 rounded-md border border-line-soft p-3">
                {hit.iconUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={hit.iconUrl} alt="" width={36} height={36} className="rounded" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{hit.title}</p>
                  <p className="line-clamp-2 text-sm text-muted">{hit.description}</p>
                  <p className="tnum mt-1 text-xs text-muted">
                    {hit.downloads.toLocaleString()} downloads
                  </p>
                </div>
                <button
                  onClick={() => install(hit.id, hit.title)}
                  disabled={busy === hit.id}
                  className="shrink-0 rounded-md border border-line px-3 py-1.5 text-sm hover:border-gold hover:text-gold disabled:opacity-40"
                >
                  {busy === hit.id ? "Installing…" : "Install"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {installed.map(({ slot, items }) => (
        <Panel
          key={slot.id}
          title={slot.label}
          description={`Stored in ${slot.dir}`}
          action={
            <>
              <input
                ref={fileInput}
                type="file"
                accept={slot.extensions.join(",")}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void upload(slot.id, file);
                  e.target.value = "";
                }}
              />
              <button
                onClick={() => fileInput.current?.click()}
                disabled={busy === "upload"}
                className="rounded-md border border-line px-3 py-1.5 text-sm hover:border-gold hover:text-gold disabled:opacity-40"
              >
                {busy === "upload" ? "Uploading…" : "Upload a file"}
              </button>
            </>
          }
        >
          {items.length === 0 ? (
            <p className="text-sm text-muted">
              Nothing here yet. Search above, or upload a {slot.extensions.join(" or ")} file.
            </p>
          ) : (
            <ul className="divide-y divide-line-soft">
              {items.map((item) => (
                <li key={item.name} className="flex items-center gap-3 py-2.5">
                  <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
                  <span className="tnum text-xs text-muted">{size(item.sizeBytes)}</span>
                  <button
                    onClick={() => remove(slot.id, item.name)}
                    disabled={busy === item.name}
                    className="text-xs text-muted hover:text-coral disabled:opacity-40"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ))}
    </div>
  );
}
