import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { BackupStorage } from "./storage";

/**
 * S3-compatible storage (AWS, Backblaze B2, Cloudflare R2, MinIO) using SigV4
 * over fetch. Written by hand rather than pulling the AWS SDK because the agent
 * ships as a single bundled file onto customer machines and every megabyte of
 * dependency is a megabyte to audit.
 */
export class S3Storage implements BackupStorage {
  readonly name = "s3";

  constructor(
    private config: {
      endpoint: string; // https://s3.us-west-002.backblazeb2.com
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
    },
  ) {}

  private sign(
    method: string,
    key: string,
    payloadHash: string,
    extraHeaders: Record<string, string> = {},
  ) {
    const url = new URL(`${this.config.endpoint}/${this.config.bucket}/${key}`);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);

    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...extraHeaders,
    };

    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((h) => `${h}:${headers[h]}\n`)
      .join("");

    const canonicalRequest = [
      method,
      url.pathname,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");

    const hmac = (key: Buffer | string, data: string) =>
      createHmac("sha256", key).update(data).digest();

    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, dateStamp), this.config.region), "s3"),
      "aws4_request",
    );
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return { url: url.toString(), headers };
  }

  async upload(localPath: string, key: string) {
    const info = await stat(localPath);

    // Archives are hashed in full before upload: S3 requires the payload hash in
    // the signature, and it doubles as the integrity check on restore.
    const hash = createHash("sha256");
    await pipeline(createReadStream(localPath), async function* (source) {
      for await (const chunk of source) hash.update(chunk as Buffer);
    });
    const payloadHash = hash.digest("hex");

    const { url, headers } = this.sign("PUT", key, payloadHash, {
      "content-length": String(info.size),
    });

    const res = await fetch(url, {
      method: "PUT",
      headers,
      body: Readable.toWeb(createReadStream(localPath)) as ReadableStream,
      // @ts-expect-error duplex is required by Node for streaming bodies
      duplex: "half",
    });

    if (!res.ok) throw new Error(`Backup upload failed: ${res.status} ${await res.text()}`);
    return { key, bytes: info.size };
  }

  async download(key: string, localPath: string) {
    const { url, headers } = this.sign("GET", key, "UNSIGNED-PAYLOAD");
    const res = await fetch(url, { headers });
    if (!res.ok || !res.body) throw new Error(`Backup download failed: ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(localPath));
  }

  async remove(key: string) {
    const { url, headers } = this.sign("DELETE", key, createHash("sha256").update("").digest("hex"));
    const res = await fetch(url, { method: "DELETE", headers });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Backup delete failed: ${res.status}`);
    }
  }
}

/** Returns null when no object store is configured, meaning keep archives local. */
export function storageFromEnv(): S3Storage | null {
  const {
    DEERS_S3_ENDPOINT,
    DEERS_S3_REGION,
    DEERS_S3_BUCKET,
    DEERS_S3_ACCESS_KEY_ID,
    DEERS_S3_SECRET_ACCESS_KEY,
  } = process.env;

  if (
    !DEERS_S3_ENDPOINT ||
    !DEERS_S3_BUCKET ||
    !DEERS_S3_ACCESS_KEY_ID ||
    !DEERS_S3_SECRET_ACCESS_KEY
  ) {
    return null;
  }

  return new S3Storage({
    endpoint: DEERS_S3_ENDPOINT,
    region: DEERS_S3_REGION ?? "us-east-1",
    bucket: DEERS_S3_BUCKET,
    accessKeyId: DEERS_S3_ACCESS_KEY_ID,
    secretAccessKey: DEERS_S3_SECRET_ACCESS_KEY,
  });
}
