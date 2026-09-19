import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Symmetric encryption for secrets the panel must be able to read back —
 * database passwords it shows the customer, and database-host admin credentials.
 *
 * This is deliberately NOT used for anything that can be hashed instead. Agent
 * tokens and user passwords are bcrypt hashes and are never recoverable.
 */

const ALGORITHM = "aes-256-gcm";

function key(): Buffer {
  const secret = process.env.DATABASE_HOST_KEY;
  if (!secret || secret.length < 32) {
    throw new Error("DATABASE_HOST_KEY must be set to at least 32 characters.");
  }
  // Static salt is acceptable here: the input is already a high-entropy secret,
  // not a user password, and it must derive identically across panel replicas.
  return scryptSync(secret, "deers-db-host", 32);
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed encrypted value.");
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

export function generatePassword(length = 24): string {
  // Excludes characters that break MySQL connection strings or shell quoting.
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
