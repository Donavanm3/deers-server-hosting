import { prisma } from "./db";
import { callAgent } from "./agent-rpc";

/**
 * Game server settings.
 *
 * Customers should not have to hand-edit `server.properties` to change the
 * difficulty. This reads the real config file off the node, presents the keys
 * that matter as typed fields, and writes back only what changed — comments,
 * ordering and unknown keys in the file are preserved untouched, because a
 * modpack may depend on keys we have never heard of.
 */

export type FieldType = "text" | "number" | "boolean" | "select";

export interface SettingField {
  key: string;
  label: string;
  help?: string;
  type: FieldType;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  /** Changing this needs a restart before it takes effect. */
  restart?: boolean;
  /** Never exposed to the customer — we manage it. */
  managed?: boolean;
}

const JAVA_FIELDS: SettingField[] = [
  { key: "motd", label: "Server description", help: "Shown in the multiplayer list.", type: "text" },
  {
    key: "gamemode",
    label: "Default game mode",
    type: "select",
    options: [
      { value: "survival", label: "Survival" },
      { value: "creative", label: "Creative" },
      { value: "adventure", label: "Adventure" },
      { value: "spectator", label: "Spectator" },
    ],
  },
  {
    key: "difficulty",
    label: "Difficulty",
    type: "select",
    options: [
      { value: "peaceful", label: "Peaceful" },
      { value: "easy", label: "Easy" },
      { value: "normal", label: "Normal" },
      { value: "hard", label: "Hard" },
    ],
  },
  { key: "max-players", label: "Player limit", type: "number", min: 1, max: 200 },
  { key: "pvp", label: "Players can damage each other", type: "boolean" },
  { key: "hardcore", label: "Hardcore mode", help: "Death bans the player.", type: "boolean", restart: true },
  { key: "white-list", label: "Whitelist only", help: "Only invited players can join.", type: "boolean" },
  { key: "online-mode", label: "Require a Minecraft account", type: "boolean", restart: true },
  { key: "spawn-protection", label: "Spawn protection radius", type: "number", min: 0, max: 64 },
  { key: "view-distance", label: "View distance", help: "Higher values cost more memory.", type: "number", min: 3, max: 32 },
  { key: "simulation-distance", label: "Simulation distance", type: "number", min: 3, max: 32 },
  { key: "allow-flight", label: "Allow flight", help: "Needed by some mods and plugins.", type: "boolean" },
  { key: "allow-nether", label: "Nether enabled", type: "boolean", restart: true },
  { key: "enable-command-block", label: "Command blocks work", type: "boolean", restart: true },
  { key: "level-seed", label: "World seed", help: "Only applies to a freshly generated world.", type: "text", restart: true },
  { key: "level-name", label: "World folder", type: "text", restart: true },
  // Managed by us — surfacing them invites customers to break their own server.
  { key: "server-port", label: "Port", type: "number", managed: true },
  { key: "server-ip", label: "Bind address", type: "text", managed: true },
  { key: "rcon.port", label: "RCON port", type: "number", managed: true },
  { key: "query.port", label: "Query port", type: "number", managed: true },
];

const BEDROCK_FIELDS: SettingField[] = [
  { key: "server-name", label: "Server name", type: "text" },
  {
    key: "gamemode",
    label: "Default game mode",
    type: "select",
    options: [
      { value: "survival", label: "Survival" },
      { value: "creative", label: "Creative" },
      { value: "adventure", label: "Adventure" },
    ],
  },
  {
    key: "difficulty",
    label: "Difficulty",
    type: "select",
    options: [
      { value: "peaceful", label: "Peaceful" },
      { value: "easy", label: "Easy" },
      { value: "normal", label: "Normal" },
      { value: "hard", label: "Hard" },
    ],
  },
  { key: "max-players", label: "Player limit", type: "number", min: 1, max: 100 },
  { key: "allow-cheats", label: "Cheats allowed", type: "boolean", restart: true },
  { key: "online-mode", label: "Require an Xbox Live account", type: "boolean", restart: true },
  { key: "view-distance", label: "View distance", type: "number", min: 4, max: 32 },
  { key: "tick-distance", label: "Tick distance", type: "number", min: 4, max: 12 },
  { key: "player-idle-timeout", label: "Kick idle players after (minutes)", type: "number", min: 0, max: 120 },
  { key: "level-name", label: "World folder", type: "text", restart: true },
  { key: "level-seed", label: "World seed", type: "text", restart: true },
  { key: "server-port", label: "Port", type: "number", managed: true },
];

interface GameProfile {
  file: string;
  fields: SettingField[];
}

export function profileForTemplate(templateKey: string): GameProfile {
  if (templateKey.includes("bedrock")) {
    return { file: "/server.properties", fields: BEDROCK_FIELDS };
  }
  return { file: "/server.properties", fields: JAVA_FIELDS };
}

/** Parses `key=value` config, keeping comments and blank lines as-is. */
export function parseProperties(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Writes changed values back into the original text, in place. Keys that were
 * not in the file are appended; everything else keeps its position, so a
 * customer's comments and a modpack's unknown keys survive an edit.
 */
export function applyProperties(original: string, changes: Record<string, string>): string {
  const remaining = new Map(Object.entries(changes));
  const lines = original.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) return line;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (!remaining.has(key)) return line;
    const value = remaining.get(key)!;
    remaining.delete(key);
    return `${key}=${value}`;
  });

  for (const [key, value] of remaining) lines.push(`${key}=${value}`);
  return lines.join("\n");
}

export async function readGameSettings(serverId: string) {
  const server = await prisma.server.findUniqueOrThrow({
    where: { id: serverId },
    include: { template: true },
  });
  const profile = profileForTemplate(server.template.key);

  let text = "";
  try {
    const res = await callAgent<{ contentBase64: string }>(server.nodeId, {
      op: "files.read",
      serverId,
      path: profile.file,
      maxBytes: 200_000,
    });
    text = Buffer.from(res.contentBase64, "base64").toString("utf8");
  } catch {
    // The file only exists after the server has started once.
    return { ready: false, fields: [], values: {} as Record<string, string> };
  }

  const parsed = parseProperties(text);
  const visible = profile.fields.filter((f) => !f.managed);
  const values: Record<string, string> = {};
  for (const field of visible) values[field.key] = parsed.get(field.key) ?? "";

  return { ready: true, fields: visible, values };
}

export async function writeGameSettings(serverId: string, changes: Record<string, string>) {
  const server = await prisma.server.findUniqueOrThrow({
    where: { id: serverId },
    include: { template: true },
  });
  const profile = profileForTemplate(server.template.key);

  const editable = new Map(profile.fields.filter((f) => !f.managed).map((f) => [f.key, f]));
  const accepted: Record<string, string> = {};
  const rejected: string[] = [];

  for (const [key, raw] of Object.entries(changes)) {
    const field = editable.get(key);
    // Silently dropping unknown keys is what stops a crafted request from
    // rewriting server-port and taking the container off its allocation.
    if (!field) {
      rejected.push(key);
      continue;
    }
    const value = coerce(field, raw);
    if (value !== null) accepted[key] = value;
    else rejected.push(key);
  }

  const res = await callAgent<{ contentBase64: string }>(server.nodeId, {
    op: "files.read",
    serverId,
    path: profile.file,
    maxBytes: 200_000,
  });
  const original = Buffer.from(res.contentBase64, "base64").toString("utf8");
  const updated = applyProperties(original, accepted);

  await callAgent(server.nodeId, {
    op: "files.write",
    serverId,
    path: profile.file,
    contentBase64: Buffer.from(updated, "utf8").toString("base64"),
  });

  const needsRestart = Object.keys(accepted).some((k) => editable.get(k)?.restart);
  return { saved: Object.keys(accepted), rejected, needsRestart };
}

function coerce(field: SettingField, raw: string): string | null {
  switch (field.type) {
    case "boolean":
      return raw === "true" || raw === "false" ? raw : null;
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      if (field.min !== undefined && n < field.min) return null;
      if (field.max !== undefined && n > field.max) return null;
      return String(Math.round(n));
    }
    case "select":
      return field.options?.some((o) => o.value === raw) ? raw : null;
    case "text":
      // Newlines would inject a second key into the file.
      return raw.length <= 512 && !/[\r\n]/.test(raw) ? raw : null;
  }
}
