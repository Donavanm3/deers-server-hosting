import { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth";
import { AgentError } from "@/lib/agent-rpc";
import { NoCapacityError } from "@/lib/scheduler";

/** Single error funnel so internal details never leak to customers. */
export function fail(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof NoCapacityError) {
    return NextResponse.json(
      { error: "No capacity is available for this plan right now. Try another location or contact support." },
      { status: 503 },
    );
  }
  if (err instanceof AgentError) {
    return NextResponse.json({ error: err.message }, { status: err.code === "node_offline" ? 503 : 502 });
  }
  console.error("[api]", err);
  return NextResponse.json({ error: "Something went wrong. The team has been notified." }, { status: 500 });
}
