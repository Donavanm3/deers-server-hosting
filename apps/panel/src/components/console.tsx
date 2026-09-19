"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Status, statusTone } from "./ui";

interface Line { id: number; stream: "stdout" | "stderr"; line: string }

/**
 * Live console. The browser asks the panel for a single-use ticket, then opens
 * the gateway socket with it — no node address or agent token ever reaches the
 * client, and input goes to the game process stdin, never a host shell.
 */
export function Console({ serverId, initialStatus }: { serverId: string; initialStatus: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState(initialStatus);
  const [canCommand, setCanCommand] = useState(false);
  const [connection, setConnection] = useState<"connecting" | "open" | "closed">("connecting");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const counter = useRef(0);

  const connect = useCallback(async () => {
    setConnection("connecting");
    const res = await fetch(`/api/servers/${serverId}/console-ticket`, { method: "POST" });
    if (!res.ok) {
      setError((await res.json()).error ?? "The console is unavailable right now.");
      setConnection("closed");
      return;
    }
    const { url, canCommand: allowed } = await res.json();
    setCanCommand(allowed);

    const ws = new WebSocket(url);
    socketRef.current = ws;
    ws.onopen = () => { setConnection("open"); setError(null); };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "state") return setStatus(msg.status);
      if (msg.type === "console") {
        setLines((prev) => [...prev.slice(-999), { id: counter.current++, stream: msg.stream, line: msg.line }]);
      }
    };
    ws.onclose = () => setConnection("closed");
  }, [serverId]);

  useEffect(() => {
    void connect();
    return () => socketRef.current?.close();
  }, [connect]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: "end" }); }, [lines]);

  async function power(action: "start" | "stop" | "restart") {
    setError(null);
    const res = await fetch(`/api/servers/${serverId}/power`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) setError((await res.json()).error);
  }

  function submit() {
    const command = input.trim();
    if (!command || socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type: "command", command }));
    setInput("");
  }

  const running = status === "RUNNING";

  return (
    <section className="overflow-hidden rounded-[10px] border border-line-soft bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line-soft px-5 py-3">
        <Status tone={statusTone(status)}>{status.toLowerCase()}</Status>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => power("start")}
            disabled={running}
            className="rounded-md border border-line px-3 py-1.5 text-sm hover:border-mint hover:text-mint disabled:opacity-30"
          >
            Start
          </button>
          <button
            onClick={() => power("restart")}
            className="rounded-md border border-line px-3 py-1.5 text-sm hover:border-gold hover:text-gold"
          >
            Restart
          </button>
          <button
            onClick={() => power("stop")}
            disabled={!running}
            className="rounded-md border border-line px-3 py-1.5 text-sm hover:border-coral hover:text-coral disabled:opacity-30"
          >
            Stop
          </button>
        </div>
      </div>

      {error && <p className="border-b border-line-soft bg-coral-dim px-5 py-2 text-sm text-coral">{error}</p>}

      <div className="terminal h-[26rem] overflow-y-auto bg-bg px-5 py-4">
        {connection === "connecting" && <p className="text-muted">Opening the console…</p>}
        {connection === "closed" && (
          <p className="text-muted">
            Console disconnected.{" "}
            <button onClick={() => void connect()} className="text-gold underline">Reconnect</button>
          </p>
        )}
        {connection === "open" && lines.length === 0 && (
          <p className="text-muted">Quiet so far. Start the server and output will appear here.</p>
        )}
        {lines.map((l) => (
          <div key={l.id} className={l.stream === "stderr" ? "text-coral" : undefined}>{l.line}</div>
        ))}
        <div ref={bottomRef} />
      </div>

      {canCommand && (
        <div className="flex gap-2 border-t border-line-soft px-5 py-3">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Type a command, like: say hello"
            aria-label="Server command"
            className="terminal flex-1 rounded-md border border-line bg-bg px-3 py-2"
          />
          <button onClick={submit} className="rounded-md bg-gold px-4 py-2 text-sm font-semibold text-bg">
            Send
          </button>
        </div>
      )}
    </section>
  );
}
