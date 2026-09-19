/**
 * Where backup archives end up after the agent creates them.
 *
 * The default keeps them on the node, which is fast but dies with the disk.
 * Configure an object store and the same archive is uploaded and the local copy
 * dropped, so losing a node no longer loses its customers' backups.
 */
export interface BackupStorage {
  readonly name: string;
  /** Returns the key the archive can later be fetched by. */
  upload(localPath: string, key: string): Promise<{ key: string; bytes: number }>;
  download(key: string, localPath: string): Promise<void>;
  remove(key: string): Promise<void>;
}
