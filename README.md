# DeersServerHosting

Node-based game server hosting. A node is any machine that can run containers — a VPS, a dedicated box, or someone's home server. Nothing in the code assumes a particular machine, count, or address.

```
Customer ──owns──> Game Server ──placed on──> Node ──runs──> Deers Node Agent
                        │                        │
                   PostgreSQL row          Docker container
```

## How the pieces talk

The control plane never dials a node. Each agent opens an outbound WSS connection to the gateway and keeps it alive, which is what makes home nodes behind NAT and dynamic IPs work with no extra configuration.

```
Browser ──HTTPS──> Panel (Next.js) ──Redis pub/sub──> Gateway ──WSS──> Agent ──> Docker
                        │                                 ▲
                        └────── PostgreSQL ───────────────┘
```

- **Panel** (`apps/panel`) — customer and admin UI plus the REST API. Stateless, so it scales horizontally.
- **Gateway** (`apps/gateway`) — holds the agent sockets, authenticates them against the node's hashed token, and bridges commands and replies over Redis. Also serves the browser console socket.
- **Agent** (`apps/agent`) — runs on the node. Reports telemetry, manages containers, streams console, does file and backup work.
- **Shared** (`packages/shared`) — the wire protocol, versioned so an old agent is rejected rather than misunderstood.

## Resource accounting

A node's free capacity comes from reservations, never from live telemetry — a stopped server still owns its RAM.

```
available = total − reserved − overhead
```

`overhead` is headroom for the OS, Docker and the agent, set per node.

Placement happens in one PostgreSQL transaction:

1. Select online, enabled, template-capable nodes with a fresh heartbeat and enough free capacity, `FOR UPDATE`.
2. Prefer the requested location if anything there fits.
3. Score the survivors on how balanced they'd be *after* placement and take the best.
4. `UPDATE` the reserved counters, re-checking capacity in the `WHERE` clause.
5. Claim a port allocation with `FOR UPDATE SKIP LOCKED`.
6. Write the `Server` row.

Because the candidate rows are locked before the free figure is read, two simultaneous purchases serialise instead of both seeing the same headroom. `tests/scheduler.test.ts` fires ten concurrent 2 GB purchases at a 16 GB node and asserts that exactly eight succeed.

If the agent then fails to build the container, the reservation is released, the allocation freed, the server row deleted, and the next candidate node is tried — up to three nodes before the order is marked failed.

## Security model

- Agent tokens are stored as bcrypt hashes. The plaintext is shown once, at node creation.
- No API response ever contains a node's address, credentials, or token — customers get a server id and a connection address.
- The console socket uses a single-use, 30-second ticket minted by the panel. The browser never learns which node it is talking to.
- Console input is written to the game process stdin. There is no path from a customer request to a host shell.
- Containers run as uid 988 with `CapDrop: ALL`, `no-new-privileges`, no swap beyond the RAM limit, a pids limit, and a noexec `/tmp`.
- File paths from customers are resolved through `realpath` before the jail check, so a symlink cannot be used to escape the server directory.
- Every server-scoped route goes through `requireServerAccess`, the single place ownership and subuser permissions are decided.
- Administrative actions write to `AuditLog`.

## Running it

```bash
cp .env.example .env
docker compose up -d postgres redis
npm install
npx prisma db push
SEED_ADMIN_PASSWORD='choose-something-strong' npm run db:seed
npm run dev:gateway   # :8080
npm run dev:panel     # :3000
```

Then in the panel: **Admin → Nodes → Add node**. Enter the machine's real CPU, RAM and disk, pick which game templates it may host, and set a port range. The panel prints the agent environment block once.

On the node itself:

```bash
export DEERS_PANEL_URL=wss://panel.example.com/agent
export DEERS_NODE_ID=...
export DEERS_NODE_TOKEN=...
sudo -E ./scripts/install-agent.sh
```

The node appears online within about 30 seconds. Adding the second, tenth or fiftieth node needs no code change — capacity simply becomes schedulable.

Run the tests with a database available:

```bash
DATABASE_URL=postgresql://deers:deers@localhost:5432/deers npm test
```

## Build stages

| Stage | Scope | State |
| --- | --- | --- |
| 1 | Schema, auth, sessions, audit log | built |
| 2 | Agent protocol, gateway, heartbeats, reconnect, reconciliation | built |
| 3 | Scheduler, atomic reservation, allocations, provisioning with rollback | built, tested |
| 4 | Docker provider: lifecycle, stats, console, files, backups | built |
| 5 | Panel: nodes admin, server view, live console, power, file API | built |
| 6 | Billing: invoices, signed payment webhook, suspension, reclamation | built |
| 7 | Backups: manual, scheduled, pruning, restore | built |
| 8 | Subusers, startup variables, auth and session handling | built |
| 9 | Node migration and drain for maintenance | built |
| 10 | Metrics sampling and compaction, fleet reconciler, worker | built |

See `OPERATIONS.md` for deployment and day-to-day running.

| 11 | Off-node backup storage (S3-compatible), streamed and checksummed | built |
| 12 | Agent self-update with checksum verification and staged rollout | built |
| 13 | Operator alerting with deduplication; capacity and node-down warnings | built |
| 14 | Customer panel: dashboard, plans and checkout, files, backups, startup, network | built |

Remaining work, in the order I'd tackle it: SFTP access for files over 2 MB, a database-hosting feature to back the `databaseLimit` field that plans already carry, and per-server bandwidth accounting.

## What is deliberately not here

No mock data anywhere — every panel figure is a Postgres read or the agent's last heartbeat. If a node is offline, the UI says so rather than showing stale numbers.
