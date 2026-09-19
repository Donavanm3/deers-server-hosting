import { prisma } from "./db";
import { callAgent } from "./agent-rpc";
import { audit } from "./audit";
import type { FileEntry } from "@deers/shared/protocol";

/**
 * Mods, plugins and Bedrock addons.
 *
 * Content is fetched by the panel and pushed to the node as bytes, rather than
 * having the agent fetch URLs itself — an agent that will download and write
 * arbitrary URLs is a much larger hole than one that only accepts content the
 * panel has already vetted.
 */

const MAX_BYTES = 150 * 1024 * 1024;

/** Where each kind of content belongs, and what file types are legitimate there. */
const LAYOUT: Record<string, { dir: string; label: string; extensions: string[] }> = {
  "minecraft-java-paper": { dir: "/plugins", label: "Plugins", extensions: [".jar"] },
  "minecraft-java-forge": { dir: "/mods", label: "Mods", extensions: [".jar"] },
  "minecraft-bedrock-behavior": { dir: "/behavior_packs", label: "Behaviour packs", extensions: [".mcpack", ".mcaddon", ".zip"] },
  "minecraft-bedrock-resource": { dir: "/resource_packs", label: "Resource packs", extensions: [".mcpack", ".mcaddon", ".zip"] },
};

export class ModError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModError";
  }
}

export interface ModSlot {
  id: string;
  dir: string;
  label: string;
  extensions: string[];
}

/**
 * Which install locations a server actually has. A Paper server has plugins but
 * not mods; a Forge server the reverse. Offering both would let a customer drop
 * a plugin into a server that will never load it and then file a ticket.
 */
export async function slotsForServer(serverId: string): Promise<ModSlot[]> {
  const server = await prisma.server.findUniqueOrThrow({
    where: { id: serverId },
    include: { template: true },
  });

  if (server.template.key.includes("bedrock")) {
    return [
      { id: "behavior", ...LAYOUT["minecraft-bedrock-behavior"] },
      { id: "resource", ...LAYOUT["minecraft-bedrock-resource"] },
    ];
  }

  const env = server.environment as Record<string, string>;
  const type = (env.TYPE ?? "VANILLA").toUpperCase();

  if (["PAPER", "SPIGOT", "BUKKIT", "PURPUR", "FOLIA"].includes(type)) {
    return [{ id: "plugins", ...LAYOUT["minecraft-java-paper"] }];
  }
  if (["FORGE", "NEOFORGE", "FABRIC", "QUILT"].includes(type)) {
    return [{ id: "mods", ...LAYOUT["minecraft-java-forge"] }];
  }
  // Vanilla loads neither. Say so rather than pretending.
  return [];
}

export async function listInstalled(serverId: string) {
  const server = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
  const slots = await slotsForServer(serverId);

  const out: { slot: ModSlot; items: FileEntry[] }[] = [];
  for (const slot of slots) {
    try {
      const res = await callAgent<{ entries: FileEntry[] }>(server.nodeId, {
        op: "files.list",
        serverId,
        path: slot.dir,
      });
      out.push({
        slot,
        items: res.entries.filter((e) => !e.directory && slot.extensions.some((x) => e.name.toLowerCase().endsWith(x))),
      });
    } catch {
      // Directory does not exist yet — the server has not started once.
      out.push({ slot, items: [] });
    }
  }
  return out;
}

/** Only these hosts may be fetched from. An open URL field is an SSRF hole. */
const ALLOWED_HOSTS = [
  "cdn.modrinth.com",
  "mediafilez.forgecdn.net",
  "edge.forgecdn.net",
  "github.com",
  "objects.githubusercontent.com",
  "dev.bukkit.org",
  "hangarcdn.papermc.io",
];

async function fetchContent(url: string): Promise<{ bytes: Buffer; filename: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ModError("That does not look like a valid link.");
  }

  if (parsed.protocol !== "https:") throw new ModError("Only https links are accepted.");
  if (!ALLOWED_HOSTS.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`))) {
    throw new ModError(
      `Downloads are limited to known mod hosts. ${parsed.hostname} is not one of them.`,
    );
  }

  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new ModError(`The download failed (${res.status}).`);

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new ModError("That file is larger than 150 MB.");

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new ModError("That file is larger than 150 MB.");

  const fromUrl = decodeURIComponent(parsed.pathname.split("/").pop() ?? "");
  return { bytes, filename: fromUrl || "download.jar" };
}

/** Rejects anything that could escape the install directory. */
function safeFilename(name: string, slot: ModSlot): string {
  const base = name.replace(/^.*[\\/]/, "").trim();
  if (!base || base.startsWith(".")) throw new ModError("That filename is not allowed.");
  if (!/^[\w .()\-\[\]]+$/.test(base)) {
    throw new ModError("Use only letters, numbers, spaces, dots and dashes in the filename.");
  }
  if (!slot.extensions.some((x) => base.toLowerCase().endsWith(x))) {
    throw new ModError(`${slot.label} must be a ${slot.extensions.join(" or ")} file.`);
  }
  return base;
}

export async function installFromUrl(
  serverId: string,
  slotId: string,
  url: string,
  actorId?: string | null,
) {
  const server = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
  const slots = await slotsForServer(serverId);
  const slot = slots.find((s) => s.id === slotId);
  if (!slot) throw new ModError("This server does not load that kind of content.");

  const { bytes, filename } = await fetchContent(url);
  const safe = safeFilename(filename, slot);

  await callAgent(
    server.nodeId,
    {
      op: "files.write",
      serverId,
      path: `${slot.dir}/${safe}`,
      contentBase64: bytes.toString("base64"),
    },
    180_000,
  );

  await audit({
    actorId,
    action: "server.mod.install",
    targetType: "server",
    targetId: serverId,
    metadata: { slot: slot.id, filename: safe, bytes: bytes.length, source: url },
  });

  return { filename: safe, bytes: bytes.length, slot: slot.id };
}

export async function installUpload(
  serverId: string,
  slotId: string,
  filename: string,
  bytes: Buffer,
  actorId?: string | null,
) {
  const server = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
  const slots = await slotsForServer(serverId);
  const slot = slots.find((s) => s.id === slotId);
  if (!slot) throw new ModError("This server does not load that kind of content.");
  if (bytes.length > MAX_BYTES) throw new ModError("That file is larger than 150 MB.");

  const safe = safeFilename(filename, slot);

  await callAgent(
    server.nodeId,
    {
      op: "files.write",
      serverId,
      path: `${slot.dir}/${safe}`,
      contentBase64: bytes.toString("base64"),
    },
    180_000,
  );

  await audit({
    actorId,
    action: "server.mod.upload",
    targetType: "server",
    targetId: serverId,
    metadata: { slot: slot.id, filename: safe, bytes: bytes.length },
  });

  return { filename: safe, bytes: bytes.length, slot: slot.id };
}

export async function removeMod(
  serverId: string,
  slotId: string,
  filename: string,
  actorId?: string | null,
) {
  const server = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
  const slots = await slotsForServer(serverId);
  const slot = slots.find((s) => s.id === slotId);
  if (!slot) throw new ModError("Unknown install location.");

  const safe = safeFilename(filename, slot);
  await callAgent(server.nodeId, { op: "files.delete", serverId, paths: [`${slot.dir}/${safe}`] });

  await audit({
    actorId,
    action: "server.mod.remove",
    targetType: "server",
    targetId: serverId,
    metadata: { slot: slot.id, filename: safe },
  });
}

/* ------------------------------ Modrinth ------------------------------ */

export interface ModSearchResult {
  id: string;
  slug: string;
  title: string;
  description: string;
  downloads: number;
  iconUrl: string | null;
  categories: string[];
}

/**
 * Searches Modrinth so customers can install without hunting for a download
 * link. Results are filtered to the loader the server actually runs.
 */
export async function searchMods(
  serverId: string,
  query: string,
  gameVersion?: string,
): Promise<ModSearchResult[]> {
  const server = await prisma.server.findUniqueOrThrow({
    where: { id: serverId },
    include: { template: true },
  });
  if (server.template.key.includes("bedrock")) return [];

  const env = server.environment as Record<string, string>;
  const type = (env.TYPE ?? "VANILLA").toUpperCase();
  const loader = ["PAPER", "SPIGOT", "BUKKIT", "PURPUR", "FOLIA"].includes(type)
    ? type.toLowerCase()
    : type.toLowerCase();
  const version = gameVersion ?? env.VERSION;

  const facets: string[][] = [["project_type:mod", "project_type:plugin"], [`categories:${loader}`]];
  if (version) facets.push([`versions:${version}`]);

  const url = new URL("https://api.modrinth.com/v2/search");
  url.searchParams.set("query", query.slice(0, 120));
  url.searchParams.set("limit", "20");
  url.searchParams.set("facets", JSON.stringify(facets));

  const res = await fetch(url, {
    headers: { "user-agent": "DeersServerHosting/1.0 (deersserverhosting.com)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new ModError("Mod search is unavailable right now.");

  const data = (await res.json()) as { hits: Record<string, unknown>[] };
  return data.hits.map((h) => ({
    id: String(h.project_id),
    slug: String(h.slug),
    title: String(h.title),
    description: String(h.description ?? ""),
    downloads: Number(h.downloads ?? 0),
    iconUrl: h.icon_url ? String(h.icon_url) : null,
    categories: (h.categories as string[]) ?? [],
  }));
}

/** Resolves a Modrinth project to the right file for this server, then installs it. */
export async function installFromModrinth(
  serverId: string,
  projectId: string,
  actorId?: string | null,
) {
  const server = await prisma.server.findUniqueOrThrow({
    where: { id: serverId },
    include: { template: true },
  });
  const env = server.environment as Record<string, string>;
  const type = (env.TYPE ?? "VANILLA").toUpperCase();
  const version = env.VERSION;

  const url = new URL(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version`);
  if (version) url.searchParams.set("game_versions", JSON.stringify([version]));
  url.searchParams.set("loaders", JSON.stringify([type.toLowerCase()]));

  const res = await fetch(url, {
    headers: { "user-agent": "DeersServerHosting/1.0 (deersserverhosting.com)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new ModError("Could not look that up on Modrinth.");

  const versions = (await res.json()) as { files: { url: string; filename: string; primary: boolean }[] }[];
  if (versions.length === 0) {
    throw new ModError(
      `No build of this is available for ${type.toLowerCase()} ${version ?? "your version"}.`,
    );
  }

  const file = versions[0].files.find((f) => f.primary) ?? versions[0].files[0];
  const slots = await slotsForServer(serverId);
  if (slots.length === 0) throw new ModError("A vanilla server cannot load mods or plugins.");

  return installFromUrl(serverId, slots[0].id, file.url, actorId);
}
