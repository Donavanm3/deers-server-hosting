"use client";

import { useEffect, useState } from "react";
import { Panel } from "./ui";
import type { SettingField } from "@/lib/game-settings";

export function SettingsForm({ serverId }: { serverId: string }) {
  const [fields, setFields] = useState<SettingField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [original, setOriginal] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch(`/api/servers/${serverId}/settings`);
      setLoading(false);
      if (!res.ok) return setError((await res.json()).error);
      const data = await res.json();
      setReady(data.ready);
      setFields(data.fields);
      setValues(data.values);
      setOriginal(data.values);
    })();
  }, [serverId]);

  const changed = Object.keys(values).filter((k) => values[k] !== original[k]);

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    const payload = Object.fromEntries(changed.map((k) => [k, values[k]]));
    const res = await fetch(`/api/servers/${serverId}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: payload }),
    });
    setSaving(false);
    if (!res.ok) return setError((await res.json()).error);

    const result = await res.json();
    setOriginal({ ...original, ...payload });
    setNotice(
      result.needsRestart
        ? "Saved. Restart the server for these to take effect."
        : "Saved. Changes apply as players reconnect.",
    );
  }

  if (loading) return <Panel><p className="text-sm text-muted">Reading your server config…</p></Panel>;

  if (!ready) {
    return (
      <Panel>
        <p className="text-sm text-muted">
          Settings appear once the server has started for the first time and written its config file.
          Start it from the console tab, then come back.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title="Game settings"
      description="These write straight into your server config."
      action={
        <button
          onClick={save}
          disabled={saving || changed.length === 0}
          className="rounded-md bg-gold px-4 py-2 text-sm font-semibold text-bg disabled:opacity-40"
        >
          {saving ? "Saving…" : changed.length ? `Save ${changed.length} change${changed.length > 1 ? "s" : ""}` : "Saved"}
        </button>
      }
    >
      {error && <p className="mb-4 rounded-md bg-coral-dim px-3 py-2 text-sm text-coral">{error}</p>}
      {notice && <p className="mb-4 rounded-md bg-mint-dim px-3 py-2 text-sm text-mint">{notice}</p>}

      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        {fields.map((field) => {
          const value = values[field.key] ?? "";
          const isChanged = value !== original[field.key];

          return (
            <div key={field.key}>
              <label htmlFor={field.key} className="block text-sm font-medium">
                {field.label}
                {isChanged && <span className="ml-2 text-xs text-gold">edited</span>}
              </label>
              {field.help && <p className="mt-0.5 text-xs text-muted">{field.help}</p>}

              <div className="mt-2">
                {field.type === "boolean" ? (
                  <button
                    id={field.key}
                    role="switch"
                    aria-checked={value === "true"}
                    onClick={() => setValues({ ...values, [field.key]: value === "true" ? "false" : "true" })}
                    className="flex h-7 w-12 items-center rounded-full border border-line p-0.5 transition-colors"
                    style={{ background: value === "true" ? "var(--color-mint-dim)" : "var(--color-raised)" }}
                  >
                    <span
                      className="h-5 w-5 rounded-full transition-transform"
                      style={{
                        background: value === "true" ? "var(--color-mint)" : "var(--color-muted)",
                        transform: value === "true" ? "translateX(20px)" : "translateX(0)",
                      }}
                    />
                  </button>
                ) : field.type === "select" ? (
                  <select
                    id={field.key}
                    value={value}
                    onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                    className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm"
                  >
                    {field.options?.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={field.key}
                    type={field.type === "number" ? "number" : "text"}
                    value={value}
                    min={field.min}
                    max={field.max}
                    onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                    className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm tnum"
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
