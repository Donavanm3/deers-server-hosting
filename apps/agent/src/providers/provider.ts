import type { ContainerSummary, CreateServerSpec, FileEntry } from "@deers/shared/protocol";

/**
 * Everything the agent knows how to do to a game server goes through this
 * interface. Docker is the first implementation; Podman, systemd-nspawn or a
 * bare-process runner can be added without touching the agent or control plane.
 */
export interface ServerProvider {
  readonly name: string;

  createServer(spec: CreateServerSpec): Promise<{ containerId: string }>;
  deleteServer(serverId: string, wipeVolume: boolean): Promise<void>;
  startServer(serverId: string): Promise<void>;
  stopServer(serverId: string, stopCommand?: string, timeoutSeconds?: number): Promise<void>;
  restartServer(serverId: string): Promise<void>;
  killServer(serverId: string): Promise<void>;

  getStatus(serverId: string): Promise<ContainerSummary["state"]>;
  getStats(serverId: string): Promise<ContainerSummary>;
  listServers(): Promise<ContainerSummary[]>;

  /** Writes a line to the game process stdin. Never a host shell. */
  sendCommand(serverId: string, command: string): Promise<void>;
  attachConsole(
    serverId: string,
    onLine: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<() => void>;

  getFiles(serverId: string, path: string): Promise<FileEntry[]>;
  readFile(serverId: string, path: string, maxBytes: number): Promise<Buffer>;
  writeFile(serverId: string, path: string, content: Buffer): Promise<void>;
  deleteFiles(serverId: string, paths: string[]): Promise<void>;
  makeDirectory(serverId: string, path: string): Promise<void>;
  renameFile(serverId: string, from: string, to: string): Promise<void>;

  createBackup(
    serverId: string,
    backupId: string,
  ): Promise<{ bytes: number; checksum: string; objectKey?: string }>;
  restoreBackup(serverId: string, backupId: string): Promise<void>;
  deleteBackup(serverId: string, backupId: string): Promise<void>;
}
