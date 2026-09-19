import { NextResponse } from "next/server";

/**
 * Agent update channel. Agents poll this after each reconnect; if the published
 * version is newer they download the bundle, verify the SHA-256, and restart
 * themselves under systemd.
 *
 * Unauthenticated on purpose — it returns only a version string and a public
 * download URL, and the checksum is what actually protects the agent from
 * installing something it was not given.
 */
export async function GET() {
  return NextResponse.json({
    version: process.env.AGENT_RELEASE_VERSION ?? "1.0.0",
    url: process.env.AGENT_RELEASE_URL ?? null,
    sha256: process.env.AGENT_RELEASE_SHA256 ?? null,
    // Agents older than this are refused at the gateway rather than left to
    // misbehave against a protocol they do not understand.
    minimumVersion: process.env.AGENT_MINIMUM_VERSION ?? "1.0.0",
  });
}
