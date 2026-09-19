"use client";

import { useState } from "react";

interface Variable {
  key: string;
  label: string;
  value: string;
}

export function StartupEditor({
  serverId,
  variables,
}: {
  serverId: string;
  variables: Variable[];
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(variables.map((v) => [v.key, v.value])),
  );
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await fetch(`/api/servers/${serverId}/startup`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values }),
    });
    setBusy(false);
    if (!res.ok) return setError((await res.json()).error);
    setSaved(true);
  }

  if (variables.length === 0) {
    return <p className="text-muted">This game has no adjustable startup settings.</p>;
  }

  return (
    <div className="max-w-xl space-y-4">
      {variables.map((v) => (
        <label key={v.key} className="block text-sm">
          {v.label}
          <input
            value={values[v.key] ?? ""}
            onChange={(e) => setValues({ ...values, [v.key]: e.target.value })}
            className="mt-1 w-full rounded border border-line bg-panel px-3 py-2"
          />
        </label>
      ))}

      {error && <p className="text-sm text-down">{error}</p>}
      {saved && <p className="text-sm text-live">Saved. Restart the server to apply the changes.</p>}

      <button
        onClick={save}
        disabled={busy}
        className="rounded bg-sodium px-4 py-2 text-sm font-medium text-ink disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save settings"}
      </button>
    </div>
  );
}
