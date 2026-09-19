"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Plan {
  id: string;
  name: string;
  game: string;
  memoryMb: number;
  diskMb: number;
  cpuCores: number;
  backupMb: number;
  priceCents: number;
}

export function PlanPicker({ plans, locations }: { plans: Plan[]; locations: string[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Plan | null>(null);
  const [serverName, setServerName] = useState("");
  const [location, setLocation] = useState(locations[0] ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function checkout() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId: selected.id, serverName, location }),
    });
    setBusy(false);
    if (!res.ok) return setError((await res.json()).error);
    const { server } = await res.json();
    router.push(`/servers/${server.id}`);
  }

  if (locations.length === 0) {
    return (
      <p className="rounded border border-dashed border-line p-10 text-center text-muted">
        No capacity is available at the moment. Check back shortly.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {plans.map((plan) => {
          const active = selected?.id === plan.id;
          return (
            <button
              key={plan.id}
              onClick={() => setSelected(plan)}
              className={`rounded border p-5 text-left ${
                active ? "border-sodium bg-panel-raised" : "border-line bg-panel hover:border-muted"
              }`}
            >
              <div className="text-lg font-medium">{plan.name}</div>
              <div className="figure mt-2 text-2xl">${(plan.priceCents / 100).toFixed(2)}</div>
              <div className="text-xs text-muted">per month</div>
              <dl className="mt-4 space-y-1 text-sm text-muted">
                <div className="figure">{(plan.memoryMb / 1024).toFixed(0)} GB memory</div>
                <div className="figure">{(plan.diskMb / 1024).toFixed(0)} GB storage</div>
                <div className="figure">{plan.cpuCores} CPU cores</div>
                <div className="figure">
                  {plan.backupMb > 0 ? `${(plan.backupMb / 1024).toFixed(0)} GB backups` : "No backups"}
                </div>
              </dl>
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="max-w-md space-y-4 rounded border border-line bg-panel p-5">
          <h2 className="font-medium">Set up your {selected.name} server</h2>
          <label className="block text-sm">
            Server name
            <input
              value={serverName}
              onChange={(e) => setServerName(e.target.value)}
              placeholder="My survival world"
              className="mt-1 w-full rounded border border-line bg-ink px-3 py-2"
            />
          </label>
          <label className="block text-sm">
            Location
            <select
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="mt-1 w-full rounded border border-line bg-ink px-3 py-2"
            >
              {locations.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </label>
          {error && <p className="text-sm text-down">{error}</p>}
          <button
            onClick={checkout}
            disabled={busy || serverName.trim().length === 0}
            className="w-full rounded bg-sodium py-2 font-medium text-ink disabled:opacity-50"
          >
            {busy ? "Setting up your server…" : `Create server — $${(selected.priceCents / 100).toFixed(2)}/mo`}
          </button>
        </div>
      )}
    </div>
  );
}
