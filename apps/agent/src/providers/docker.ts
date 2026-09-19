import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { PassThrough } from "node:stream";
import Docker from "dockerode";
import tar from "tar-fs";
import { getBackupStorage, backupKey } from "../storage";
import type { ContainerSummary, CreateServerSpec, FileEntry } from "@deers/shared/protocol";
import type { ServerProvider } from "./provider";
import { storageFromEnv } from "../storage/s3";

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });

const DATA_ROOT = process.env.DEERS_DATA_ROOT ?? "/var/lib/deers/servers";
/** Unprivileged uid:gid the game process runs as. Never root. */
const RUN_AS = process.env.DEERS_RUN_AS ?? "988:988";
/** Null when no object store is configured; archives then stay on this node. */
const objectStore = storageFromEnv();

export class DockerProvider implements ServerProvider {
  readonly name = "docker";

  private containerName(serverId: string) {
    return `deers-${serverId}`;
  }

  private volumePath(serverId: string) {
    return path.join(DATA_ROOT, serverId);
  }

  /**
   * Resolves a customer-supplied path inside the server volume.
   * Symlinks are resolved before the prefix check, so a symlink to /etc cannot
   * be used to escape the jail.
   */
  private async resolveInVolume(serverId: string, requested: string): Promise<string> {
    const root = this.volumePath(serverId);
    const candidate = path.resolve(root, "." + path.posix.resolve("/", requested));
    if (candidate !== root && !candidate.startsWith(root + path.sep)) {
      throw new Error("Path is outside the server directory.");
    }
    // Resolve the deepest existing ancestor so new files are still allowed.
    let probe = candidate;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        const suffix = path.relative(probe, candidate);
        const final = path.resolve(real, suffix);
        if (final !== root && !final.startsWith(root + path.sep)) {
          throw new Error("Path is outside the server directory.");
        }
        return final;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        const parent = path.dirname(probe);
        if (parent === probe) return candidate;
        probe = parent;
      }
    }
  }

  async createServer(spec: CreateServerSpec): Promise<{ containerId: string }> {
    const volume = this.volumePath(spec.serverId);
    await fs.mkdir(volume, { recursive: true, mode: 0o750 });

    await this.pullImage(spec.image);

    const portBindings: Docker.PortMap = {};
    const exposed: Record<string, object> = {};
    for (const p of spec.ports) {
      const key = `${p.port}/${p.protocol}`;
      exposed[key] = {};
      portBindings[key] = [{ HostIp: p.ip, HostPort: String(p.port) }];
    }

    const container = await docker.createContainer({
      name: this.containerName(spec.serverId),
      Image: spec.image,
      Cmd: ["/bin/sh", "-c", spec.startCommand],
      Env: Object.entries(spec.environment).map(([k, v]) => `${k}=${v}`),
      WorkingDir: "/home/container",
      User: RUN_AS,
      Tty: false,
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      ExposedPorts: exposed,
      Labels: {
        "dev.deers.managed": "true",
        "dev.deers.server-id": spec.serverId,
        "dev.deers.short-id": spec.shortId,
      },
      HostConfig: {
        Binds: [`${volume}:/home/container:rw`],
        PortBindings: portBindings,
        Memory: spec.memoryMb * 1024 * 1024,
        // No swap beyond the RAM limit, so a plan cannot silently exceed its sale.
        MemorySwap: spec.memoryMb * 1024 * 1024,
        CpuQuota: Math.round(spec.cpuCores * 100_000),
        CpuPeriod: 100_000,
        PidsLimit: 512,
        // Hard isolation: no host devices, no privilege escalation, drop everything.
        Privileged: false,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        ReadonlyRootfs: false,
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
        RestartPolicy: { Name: "no" },
        LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
        NetworkMode: process.env.DEERS_NETWORK ?? "bridge",
        Ulimits: [{ Name: "nofile", Soft: 4096, Hard: 8192 }],
      },
    });

    return { containerId: container.id };
  }

  private async pullImage(image: string) {
    const existing = await docker.listImages({ filters: { reference: [image] } });
    if (existing.length > 0) return;
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
    });
  }

  async deleteServer(serverId: string, wipeVolume: boolean): Promise<void> {
    const c = docker.getContainer(this.containerName(serverId));
    await c.remove({ force: true, v: true }).catch(() => undefined);
    if (wipeVolume) await fs.rm(this.volumePath(serverId), { recursive: true, force: true });
  }

  async startServer(serverId: string): Promise<void> {
    await docker.getContainer(this.containerName(serverId)).start();
  }

  async stopServer(serverId: string, stopCommand?: string, timeoutSeconds = 30): Promise<void> {
    const c = docker.getContainer(this.containerName(serverId));
    if (stopCommand) {
      // Graceful first: most game servers save state on their own stop command.
      await this.sendCommand(serverId, stopCommand).catch(() => undefined);
      const deadline = Date.now() + timeoutSeconds * 1000;
      while (Date.now() < deadline) {
        const state = await this.getStatus(serverId);
        if (state !== "running") return;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    await c.stop({ t: 10 }).catch(() => undefined);
  }

  async restartServer(serverId: string): Promise<void> {
    await this.stopServer(serverId, undefined, 30);
    await this.startServer(serverId);
  }

  async killServer(serverId: string): Promise<void> {
    await docker.getContainer(this.containerName(serverId)).kill().catch(() => undefined);
  }

  async getStatus(serverId: string): Promise<ContainerSummary["state"]> {
    try {
      const info = await docker.getContainer(this.containerName(serverId)).inspect();
      return info.State.Status as ContainerSummary["state"];
    } catch {
      return "dead";
    }
  }

  async getStats(serverId: string): Promise<ContainerSummary> {
    const c = docker.getContainer(this.containerName(serverId));
    const info = await c.inspect();
    const stats = (await c.stats({ stream: false })) as Docker.ContainerStats;

    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const sysDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats.system_cpu_usage ?? 0);
    const cores = stats.cpu_stats.online_cpus ?? 1;
    const cpuPercent = sysDelta > 0 ? (cpuDelta / sysDelta) * cores * 100 : 0;

    return {
      serverId,
      containerId: info.Id,
      state: info.State.Status as ContainerSummary["state"],
      cpuPercent: Number(cpuPercent.toFixed(2)),
      memoryUsedMb: Math.round((stats.memory_stats.usage ?? 0) / 1024 / 1024),
      memoryLimitMb: Math.round((stats.memory_stats.limit ?? 0) / 1024 / 1024),
      diskUsedMb: await this.directorySizeMb(this.volumePath(serverId)),
      uptimeSeconds: info.State.StartedAt
        ? Math.max(0, Math.floor((Date.now() - Date.parse(info.State.StartedAt)) / 1000))
        : 0,
    };
  }

  async listServers(): Promise<ContainerSummary[]> {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: ["dev.deers.managed=true"] },
    });
    const out: ContainerSummary[] = [];
    for (const c of containers) {
      const serverId = c.Labels["dev.deers.server-id"];
      if (!serverId) continue;
      if (c.State === "running") {
        out.push(await this.getStats(serverId).catch(() => this.stub(serverId, c)));
      } else {
        out.push(this.stub(serverId, c));
      }
    }
    return out;
  }

  private stub(serverId: string, c: Docker.ContainerInfo): ContainerSummary {
    return {
      serverId,
      containerId: c.Id,
      state: c.State as ContainerSummary["state"],
      cpuPercent: 0,
      memoryUsedMb: 0,
      memoryLimitMb: 0,
      diskUsedMb: 0,
      uptimeSeconds: 0,
    };
  }

  async sendCommand(serverId: string, command: string): Promise<void> {
    const c = docker.getContainer(this.containerName(serverId));
    const stream = await c.attach({ stream: true, stdin: true, hijack: true });
    stream.write(command.replace(/[\r\n]+/g, " ") + "\n");
    stream.end();
  }

  async attachConsole(
    serverId: string,
    onLine: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<() => void> {
    const c = docker.getContainer(this.containerName(serverId));
    const logStream = await c.logs({ follow: true, stdout: true, stderr: true, tail: 200 });

    let out = "";
    let err = "";
    const push = (buf: string, which: "stdout" | "stderr", carry: (s: string) => void) => {
      const parts = buf.split("\n");
      carry(parts.pop() ?? "");
      for (const line of parts) onLine(which, line.replace(/\x1b\[[0-9;]*m/g, ""));
    };

    // Docker multiplexes stdout/stderr on one stream; demux into two sinks.
    const stdout = { write: (b: Buffer) => push((out += b.toString()), "stdout", (s) => (out = s)) };
    const stderr = { write: (b: Buffer) => push((err += b.toString()), "stderr", (s) => (err = s)) };
    docker.modem.demuxStream(logStream, stdout as never, stderr as never);

    return () => {
      (logStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    };
  }

  async getFiles(serverId: string, dir: string): Promise<FileEntry[]> {
    const target = await this.resolveInVolume(serverId, dir);
    const entries = await fs.readdir(target, { withFileTypes: true });
    const root = this.volumePath(serverId);
    const out: FileEntry[] = [];
    for (const entry of entries) {
      const full = path.join(target, entry.name);
      const stat = await fs.lstat(full);
      out.push({
        name: entry.name,
        path: "/" + path.relative(root, full).split(path.sep).join("/"),
        directory: entry.isDirectory(),
        sizeBytes: stat.size,
        modifiedAt: stat.mtimeMs,
        mode: (stat.mode & 0o777).toString(8),
      });
    }
    return out.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  }

  async readFile(serverId: string, file: string, maxBytes = 2_000_000): Promise<Buffer> {
    const target = await this.resolveInVolume(serverId, file);
    const stat = await fs.stat(target);
    if (stat.size > maxBytes) throw new Error(`File is larger than ${maxBytes} bytes.`);
    return fs.readFile(target);
  }

  async writeFile(serverId: string, file: string, content: Buffer): Promise<void> {
    const target = await this.resolveInVolume(serverId, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { mode: 0o640 });
    await this.chownToRunUser(target);
  }

  async deleteFiles(serverId: string, paths: string[]): Promise<void> {
    for (const p of paths) {
      const target = await this.resolveInVolume(serverId, p);
      if (target === this.volumePath(serverId)) throw new Error("Cannot delete the server root.");
      await fs.rm(target, { recursive: true, force: true });
    }
  }

  async makeDirectory(serverId: string, dir: string): Promise<void> {
    const target = await this.resolveInVolume(serverId, dir);
    await fs.mkdir(target, { recursive: true, mode: 0o750 });
    await this.chownToRunUser(target);
  }

  async renameFile(serverId: string, from: string, to: string): Promise<void> {
    await fs.rename(
      await this.resolveInVolume(serverId, from),
      await this.resolveInVolume(serverId, to),
    );
  }

  async createBackup(serverId: string, backupId: string): Promise<{ bytes: number; checksum: string }> {
    const storage = await getBackupStorage();
    const hash = createHash("sha256");

    // The archive is never written to disk twice: tar -> gzip -> storage, with a
    // tee into the hash on the way past. A 40 GB world streams in constant memory.
    const body = new PassThrough();
    const gz = createGzip({ level: 6 });
    gz.on("data", (chunk: Buffer) => hash.update(chunk));

    const upload = storage.put(backupKey(serverId, backupId), body);
    await pipeline(tar.pack(this.volumePath(serverId)), gz, body);
    const { bytes } = await upload;

    return { bytes, checksum: hash.digest("hex") };
  }

  async restoreBackup(serverId: string, backupId: string): Promise<void> {
    const storage = await getBackupStorage();
    const key = backupKey(serverId, backupId);
    if (!(await storage.exists(key))) {
      throw new Error("That backup is no longer in storage.");
    }

    const volume = this.volumePath(serverId);
    // Extract beside the live volume, then swap. A failed restore leaves the
    // original world untouched rather than half-overwritten.
    const staging = `${volume}.restoring`;
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true, mode: 0o750 });

    try {
      await pipeline(await storage.get(key), createGunzip(), tar.extract(staging));
    } catch (err) {
      await fs.rm(staging, { recursive: true, force: true });
      throw err;
    }

    const previous = `${volume}.previous`;
    await fs.rm(previous, { recursive: true, force: true });
    await fs.rename(volume, previous).catch(() => undefined);
    await fs.rename(staging, volume);
    await fs.rm(previous, { recursive: true, force: true });
    await this.chownToRunUser(volume);
  }

  async deleteBackup(serverId: string, backupId: string): Promise<void> {
    const storage = await getBackupStorage();
    await storage.delete(backupKey(serverId, backupId));
  }

  private async chownToRunUser(target: string) {
    const [uid, gid] = RUN_AS.split(":").map(Number);
    if (Number.isNaN(uid) || Number.isNaN(gid)) return;
    await fs.chown(target, uid, gid).catch(() => undefined);
  }

  private async directorySizeMb(dir: string): Promise<number> {
    let total = 0;
    const walk = async (current: string) => {
      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(current, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) await walk(full);
        else {
          const s = await fs.lstat(full).catch(() => null);
          if (s) total += s.size;
        }
      }
    };
    await walk(dir);
    return Math.round(total / 1024 / 1024);
  }
}
