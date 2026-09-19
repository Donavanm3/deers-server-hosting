/**
 * Wire protocol between the Deers Node Agent and the control plane gateway.
 *
 * Direction is always: agent dials out over WSS to the gateway. The control plane
 * never opens a connection to a node, so nodes work behind NAT/dynamic IPs.
 *
 * Every control-plane -> agent message that expects a result carries an `id`;
 * the agent answers with { type: "result", id, ok, data | error }.
 */

export const PROTOCOL_VERSION = 1;

export interface AgentHello {
  type: "hello";
  protocol: number;
  agentVersion: string;
  /** Plain agent token; the connection is rejected unless it matches the node's hash. */
  token: string;
  nodeId: string;
  system: {
    platform: string;
    arch: string;
    cpuCores: number;
    totalMemoryMb: number;
    totalDiskMb: number;
    dockerVersion: string | null;
  };
}

export interface AgentHeartbeat {
  type: "heartbeat";
  at: number;
  stats: NodeStats;
  containers: ContainerSummary[];
}

export interface NodeStats {
  cpuPercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  diskUsedMb: number;
  diskTotalMb: number;
  loadAvg: [number, number, number];
  uptimeSeconds: number;
}

export interface ContainerSummary {
  serverId: string;
  containerId: string;
  state: "running" | "exited" | "created" | "restarting" | "paused" | "dead";
  cpuPercent: number;
  memoryUsedMb: number;
  memoryLimitMb: number;
  diskUsedMb: number;
  uptimeSeconds: number;
}

/** Unsolicited console output, streamed while at least one viewer is attached. */
export interface AgentConsoleLine {
  type: "console";
  serverId: string;
  stream: "stdout" | "stderr";
  line: string;
  at: number;
}

export interface AgentStateChange {
  type: "state";
  serverId: string;
  state: ContainerSummary["state"];
  exitCode?: number;
}

export interface AgentResult {
  type: "result";
  id: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export type AgentMessage =
  | AgentHello
  | AgentHeartbeat
  | AgentConsoleLine
  | AgentStateChange
  | AgentResult;

/* ------------------------------ commands ------------------------------ */

export interface CreateServerSpec {
  serverId: string;
  shortId: string;
  image: string;
  startCommand: string;
  stopCommand: string;
  environment: Record<string, string>;
  memoryMb: number;
  diskMb: number;
  cpuCores: number;
  ports: { ip: string; port: number; protocol: "tcp" | "udp" }[];
}

export type CommandPayload =
  | { op: "server.create"; spec: CreateServerSpec }
  | { op: "server.delete"; serverId: string; wipeVolume: boolean }
  | { op: "server.start"; serverId: string }
  | { op: "server.stop"; serverId: string; stopCommand?: string; timeoutSeconds?: number }
  | { op: "server.restart"; serverId: string }
  | { op: "server.kill"; serverId: string }
  | { op: "server.status"; serverId: string }
  | { op: "server.stats"; serverId: string }
  | { op: "server.command"; serverId: string; command: string }
  | { op: "console.attach"; serverId: string; tailLines: number }
  | { op: "console.detach"; serverId: string }
  | { op: "files.list"; serverId: string; path: string }
  | { op: "files.read"; serverId: string; path: string; maxBytes?: number }
  | { op: "files.write"; serverId: string; path: string; contentBase64: string }
  | { op: "files.delete"; serverId: string; paths: string[] }
  | { op: "files.mkdir"; serverId: string; path: string }
  | { op: "files.rename"; serverId: string; from: string; to: string }
  | { op: "backup.create"; serverId: string; backupId: string }
  | { op: "backup.restore"; serverId: string; backupId: string }
  | { op: "backup.delete"; serverId: string; backupId: string }
  /// Agent self-update. The agent verifies the checksum before installing and
  /// exits so its supervisor restarts it on the new binary.
  | { op: "agent.update"; version: string; url: string; sha256: string }
  | { op: "agent.rollback" };

export interface ControlCommand {
  type: "command";
  id: string;
  payload: CommandPayload;
}

export interface ControlAck {
  type: "hello.ack";
  heartbeatIntervalMs: number;
  /** Servers the control plane believes live on this node, for reconciliation. */
  expectedServers: string[];
}

export type ControlMessage = ControlCommand | ControlAck | { type: "ping" };

export interface FileEntry {
  name: string;
  path: string;
  directory: boolean;
  sizeBytes: number;
  modifiedAt: number;
  mode: string;
}
