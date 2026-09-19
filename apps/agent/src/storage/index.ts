import type { BackupStorage } from "./storage";
import { LocalBackupStorage } from "./local";

let cached: BackupStorage | null = null;

/**
 * Chosen once at boot. S3 is loaded lazily so a node using local storage does
 * not need the AWS SDK installed at all.
 */
export async function getBackupStorage(): Promise<BackupStorage> {
  if (cached) return cached;

  const driver = (process.env.DEERS_BACKUP_DRIVER ?? "local").toLowerCase();
  if (driver === "s3") {
    const { S3BackupStorage } = await import("./s3");
    cached = new S3BackupStorage();
  } else {
    cached = new LocalBackupStorage();
  }

  console.log(`[agent] backup storage: ${cached.name}`);
  return cached;
}

export type { BackupStorage } from "./storage";
export { backupKey } from "./storage";
