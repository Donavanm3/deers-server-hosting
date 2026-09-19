"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const next = useSearchParams().get("next") ?? "/servers";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    setBusy(false);
    if (!res.ok) return setError((await res.json()).error);
    router.push(next);
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-sm pt-16">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-sm text-muted">Manage your game servers.</p>

      <div className="mt-8 space-y-4">
        <label className="block text-sm">
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded border border-line bg-panel px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            className="mt-1 w-full rounded border border-line bg-panel px-3 py-2"
          />
        </label>
        {error && <p className="text-sm text-down">{error}</p>}
        <button
          onClick={submit}
          disabled={busy}
          className="w-full rounded bg-sodium py-2 font-medium text-ink disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </div>
  );
}
