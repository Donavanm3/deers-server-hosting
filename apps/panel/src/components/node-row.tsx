"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export interface NodeRowData {
  id: string;
  name: string;
  hostname: string;
  location: string;
  type: string;
  status: string;
  enabled: boolean;
  connected: boolean;
  agentVersion: string | null;
  lastHeartbeat: string | null;
  servers: number;
  memory: { total: number; reserved: number; available: number };
  disk: { total: number; reserved: number; available: number };
  cpu: { total: number; reserved: number; available: number };
}

function gb(mb: number) {
  return `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;
}

/** Reserved vs total, drawn as a filled track so oversubscription is obvious. */
function Meter({ reserved, total, label }: { reserved: number; total: number; label: string }) {
  const pct = total > 0 ? Math.min(100, (reserved / total) * 100) : 0;
  return (
    <div className="min-w-32">
      <div className="figure text-xs text-muted">{label}</div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-line">
        <div
          className="h-1.5 rounded-full"
          style={{
            width: `${pct}%`,
            background: pct > 90 ? "var(--color-down)" : "var(--color-live)",
          }}
        />
      </div>
    </div>
  );
}

export function NodeRow({ node }: { node: NodeRowData }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function toggleEnabled() {
    setError(null);
    const res = await fetch(`/api/admin/nodes/${node.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !node.enabled }),
    });
    if (!res.ok) {
      setError((await res.json()).error ?? "Could not change this node.");
      return;
    }
    startTransition(() => router.refresh());
  }

  const heartbeatAge = node.lastHeartbeat
    ? Math.round((Date.now() - Date.parse(node.lastHeartbeat)) / 1000)
    : null;

  return (
    <tr className="border-t border-line bg-panel-raised/40 align-top">
      <td className="px-4 py-4">
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: node.connected ? "var(--color-live)" : "var(--color-down)" }}
            aria-hidden
          />
          <span className="font-medium">{node.name}</span>
          {!node.enabled && (
            <span className="rounded border border-sodium/50 px-1.5 py-0.5 text-xs text-sodium">
              Taking no new servers
            </span>
          )}
        </div>
        <div className="mt-1 text-xs text-muted">
          {node.location} · {node.type.toLowerCase()} · {node.hostname}
        </div>
        <div className="mt-1 text-xs text-muted">
          {node.connected
            ? `agent ${node.agentVersion ?? "?"}, last beat ${heartbeatAge ?? "?"}s ago`
            : "agent has not checked in"}
        </div>
        {error && <div className="mt-2 text-xs text-down">{error}</div>}
      </td>
      <td className="px-4 py-4">
        <div className="figure">{gb(node.memory.available)} free</div>
        <Meter reserved={node.memory.reserved} total={node.memory.total} label={`${gb(node.memory.reserved)} of ${gb(node.memory.total)}`} />
      </td>
      <td className="px-4 py-4">
        <div className="figure">{gb(node.disk.available)} free</div>
        <Meter reserved={node.disk.reserved} total={node.disk.total} label={`${gb(node.disk.reserved)} of ${gb(node.disk.total)}`} />
      </td>
      <td className="px-4 py-4">
        <div className="figure">{(node.cpu.available).toFixed(1)} free</div>
        <Meter reserved={node.cpu.reserved} total={node.cpu.total} label={`${node.cpu.reserved.toFixed(1)} of ${node.cpu.total} cores`} />
      </td>
      <td className="figure px-4 py-4">{node.servers}</td>
      <td className="px-4 py-4 text-right">
        <button
          onClick={toggleEnabled}
          disabled={pending}
          className="rounded border border-line px-3 py-1.5 text-xs hover:border-sodium hover:text-sodium disabled:opacity-50"
        >
          {node.enabled ? "Stop new placements" : "Allow new servers"}
        </button>
      </td>
    </tr>
  );
}
