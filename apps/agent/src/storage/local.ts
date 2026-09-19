import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { BackupStorage } from "./storage";

/** Archives on the node's own disk. Default, and fine for development. */
export class LocalBackupStorage implements BackupStorage {
  readonly name = "local";

  constructor(private root = process.env.DEERS_BACKUP_ROOT ?? "/var/lib/deers/backups") {}

  private resolve(key: string) {
    const target = path.resolve(this.root, key);
    if (!target.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error("Backup key escapes the backup root.");
    }
    return target;
  }

  async put(key: string, body: Readable) {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await pipeline(body, createWriteStream(target));
    const stat = await fs.stat(target);
    return { bytes: stat.size };
  }

  async get(key: string) {
    return createReadStream(this.resolve(key));
  }

  async delete(key: string) {
    await fs.rm(this.resolve(key), { force: true });
  }

  async exists(key: string) {
    return fs
      .access(this.resolve(key))
      .then(() => true)
      .catch(() => false);
  }
}
