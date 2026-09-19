# Running DeersServerHosting on a VPS

This is the operational guide. The README covers architecture; this covers getting it live and using it day to day.

## What each piece is and why it exists

| Piece | Runs where | What it's for |
| --- | --- | --- |
| `apps/panel` | control plane | The website. Customer pages, admin pages, and the REST API. Stateless — run as many as you like behind a load balancer. |
| `apps/gateway` | control plane | Holds the long-lived socket to every node. Agents dial *in* to it; it never dials out. Also serves the browser console socket. |
| `apps/worker` | control plane | Billing cycle, scheduled backups, metrics sampling and compaction, fleet reconciliation. Safe to run more than one — every pass takes a Redis lock. |
| `apps/agent` | each node | The only thing installed on a hosting machine. Talks to Docker, reports telemetry, streams console, does file and backup work. |
| `packages/shared` | both | The wire protocol, versioned. An agent speaking the wrong version is rejected rather than misunderstood. |
| `prisma/schema.prisma` | control plane | The database. The `reserved_*` columns on `Node` are what the scheduler sells against. |
| `prisma/seed.ts` | run once | Creates your admin account, the Minecraft Java and Bedrock templates, and three example plans. |
| `scripts/install-agent.sh` | each node | Creates the unprivileged `deers` user, writes the systemd unit, starts the agent. |
| `tests/scheduler.test.ts` | your machine or CI | Proves the reservation locking actually holds under concurrency. Run it after any scheduler change. |
| `docker-compose.yml` | control plane | Postgres, Redis, panel, gateway, worker. Nodes are deliberately *not* in here — they're separate machines. |

The split that matters: **the control plane is one box (or a cluster), and every node is a separate box.** They only ever talk over the agent's outbound connection.

## First deploy

On a fresh Ubuntu 24.04 VPS:

```bash
sudo apt update && sudo apt install -y curl git ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
```

Get the code up and configure it:

```bash
sudo git clone <your-repo> /opt/deers && cd /opt/deers
cp .env.example .env
```

Edit `.env` before anything else. Three values matter now:

- `PUBLIC_GATEWAY_URL` — what agents dial, e.g. `wss://panel.yourdomain.com/agent`
- `PUBLIC_GATEWAY_WS` — what browsers dial, e.g. `wss://panel.yourdomain.com`
- `PAYMENT_WEBHOOK_SECRET` — a long random string; the webhook route refuses to run without it

Then bring it up:

```bash
docker compose up -d postgres redis
npm install
npx prisma db push
SEED_ADMIN_PASSWORD='something-long-and-random' npm run db:seed
docker compose up -d panel gateway worker
```

## TLS

Don't skip this — agent tokens and console traffic cross this connection.

```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
panel.yourdomain.com {
    reverse_proxy /agent*   localhost:8080
    reverse_proxy /console* localhost:8080
    reverse_proxy           localhost:3000
}
```

```bash
sudo systemctl reload caddy
```

Caddy gets certificates automatically and handles the WebSocket upgrade with no extra config.

## Firewall

```bash
sudo ufw allow 22,80,443/tcp
sudo ufw allow 25565:25700/tcp
sudo ufw allow 25565:25700/udp
sudo ufw enable
```

Port 8080 stays closed to the internet once Caddy proxies it. 5432 and 6379 must never be exposed — if you split the control plane across machines, put them on a private network or a WireGuard tunnel.

## Adding a node

In the panel: **Admin → Nodes → Add node**.

Enter the machine's *real* CPU cores, RAM and disk. The scheduler sells against these numbers, so inflating them oversells the box and customers will notice before you do. Leave the default overhead (1 GB RAM, 10 GB disk) unless the machine does other work. Pick which game templates it may host and a port range like 25565–25700.

The panel prints a three-line environment block **once**. Copy it now — only the hash is stored.

On the node itself, build and install the agent:

```bash
cd /opt/deers
npm run build -w @deers/agent
sudo mkdir -p /opt/deers-agent
sudo cp apps/agent/dist/agent.cjs /opt/deers-agent/

export DEERS_PANEL_URL=wss://panel.yourdomain.com/agent
export DEERS_NODE_ID=...
export DEERS_NODE_TOKEN=...
sudo -E ./scripts/install-agent.sh
```

The node goes online within about 30 seconds. If it doesn't:

```bash
sudo journalctl -u deers-agent -f
```

Close code 4403 is a bad token, 4404 is a node id that doesn't exist, 4426 is a version mismatch between agent and gateway. A connect error followed by a backoff message is a URL or TLS problem.

Adding node two, ten or fifty is the same two steps. No code changes, no config changes on the control plane.

## Day-to-day operations

**Taking a node out of rotation.** Click "Stop new placements" on the Nodes page. Existing servers keep running untouched; the scheduler just stops considering it. This is the safe first move whenever a node looks unhealthy.

**Maintenance on a node.** Call `drainNode` (Admin → Nodes → Drain) — it disables the node, then migrates each server off one at a time. Capacity on the target is reserved before anything is copied, and the source is only released once the target container exists, so a failed migration leaves the server exactly where it was.

**A customer didn't pay.** Nothing to do. The worker invoices monthly, suspends three days after the due date, and reclaims after fourteen. Suspension stops the container but keeps the files *and* the node reservation, so paying late restores the identical world. Only reclamation frees capacity, and it's always in the audit log.

**A payment arrived.** Your processor posts to `/api/billing/webhook` with an HMAC signature. Paid invoices auto-reactivate a suspended server. The handler is idempotent on the payment reference, so retries are harmless — and it returns 500 on failure specifically so the processor retries.

**Numbers look wrong on a node.** The reconciler compares reserved totals against the servers actually placed every five minutes and recalculates on drift. You can force it from Admin → Nodes with the recalculate action.

**Alerts.** Set `ALERT_WEBHOOK_URL` to a Slack or Discord webhook and the worker will tell you when a node stops reporting, when reservation drift gets corrected, and when sellable capacity drops below `ALERT_LOW_CAPACITY_GB` (default 16 GB). Each alert has a stable key and a thirty-minute cooldown, so a node down for six hours produces one message rather than 360. Leave the URL unset and alerts go to the worker's logs only.

**Updating the agent fleet.** Build the new binary, publish it somewhere the nodes can reach, and take its checksum:

```bash
npm run build -w @deers/agent
sha256sum apps/agent/dist/agent.cjs
```

Then POST to `/api/admin/agent-update` with the version, URL, checksum and a `batchSize` (default 3). The agent verifies the checksum before touching anything, keeps the old binary at `.previous`, and exits so systemd restarts it on the new one. Game servers are containers and keep running throughout — players see nothing. Nodes already on the target version are skipped.

A timeout in the response is normal and not an error: the agent exits to restart before it can reply. Watch the Nodes page instead — reconnection with the new version number is the real success signal. Roll a couple of nodes first and let them sit before doing the rest.

**Backups.** Customers create them from the panel; schedules run from the worker each minute and prune to the configured keep count.

Archives go wherever `DEERS_BACKUP_DRIVER` on the node points. Default is `local` — fast, free, and stored on the same disk as the server it protects, so one disk failure loses both. Before you take real money, switch each node to `s3`:

```bash
# in /etc/deers/agent.env on the node
DEERS_BACKUP_DRIVER=s3
DEERS_S3_BUCKET=deers-backups
DEERS_S3_ENDPOINT=https://s3.us-west-002.backblazeb2.com
DEERS_S3_REGION=us-west-002
DEERS_S3_ACCESS_KEY=...
DEERS_S3_SECRET_KEY=...
```

```bash
sudo systemctl restart deers-agent
```

Works with Backblaze B2, Wasabi, MinIO, AWS or Hetzner. Uploads stream through a multipart upload, so a 40 GB world never has to fit in the node's RAM. Give each node its own key scoped to that bucket. Existing local archives are not migrated — copy them across before switching if you need them.

**Restores** extract beside the live volume and then swap, so a restore that fails partway leaves the original world untouched rather than half-overwritten.

## Health checks

```bash
curl localhost:8080/healthz          # gateway + connected agent count
docker compose logs -f worker        # billing, backup and reconciler passes
sudo journalctl -u deers-agent -f    # on a node
```

## Verify the whole chain

Buy a plan as a test customer, then check three things: the server lands on a node, the reserved figures on the Nodes page go up by *exactly* the plan size, and the console streams output when you start it. That's provisioning, accounting and the agent link all confirmed at once.

Run the scheduler tests against a scratch database whenever you touch placement:

```bash
DATABASE_URL=postgresql://deers:deers@localhost:5432/deers_test npm test
```

## Two cautions

Running the database and game containers on one VPS means a runaway game server competes with Postgres for CPU and IO. Fine while you're testing; split it before customers depend on it.

The agent needs the Docker socket, which is effectively root on that machine. That's why nothing customer-supplied ever reaches it directly: every request is authorised by the panel first, console input goes to the game process stdin, and file paths are resolved through `realpath` before the jail check. Keep that boundary intact when you add features — it's the one place a mistake is unrecoverable.

---

# Stages 11–14: storage, databases, alerting, updates

## Off-node backups (do this before taking money)

Until you configure this, a backup lives on the same disk as the server it protects — one node failure loses both. Any S3-compatible service works; Backblaze B2 and Cloudflare R2 are the cheap options.

Create a bucket, then add to `/etc/deers/agent.env` **on each node**:

```bash
DEERS_S3_ENDPOINT=https://s3.us-west-002.backblazeb2.com
DEERS_S3_REGION=us-west-002
DEERS_S3_BUCKET=deers-backups
DEERS_S3_ACCESS_KEY_ID=...
DEERS_S3_SECRET_ACCESS_KEY=...
```

```bash
sudo systemctl restart deers-agent
```

From then on, each archive is uploaded, size-verified, and the local copy deleted. Restores pull it back down automatically. The panel records whether each backup is `NODE` or `OBJECT_STORE`, and raises an INFO alert listing any archives that predate the switch — those are still fragile until they're recreated.

The bucket credentials belong to the node, not the panel. A node can only write under `backups/<serverId>/`, so scope the key to that bucket and nothing else.

## Per-server databases

Run MySQL or MariaDB on a node (or anywhere reachable), create an admin account with `CREATE USER` and `GRANT` rights, then register it:

**Admin → Database hosts → Add host.** The panel tests the credentials before saving and encrypts them with `DATABASE_HOST_KEY`.

Set that key in `.env` to 32+ random characters and **back it up separately from your database dump** — losing it makes every stored database password unrecoverable.

Customers then create databases from their server's Databases page, limited by `databaseLimit` on their plan. Each gets a schema named `s<shortId>_<name>` and a user granted privileges on that one schema only. No `GRANT OPTION`, no global rights, so one customer's credentials are useless against another's data.

When a server is deleted, its schemas are dropped first — before the cascade removes the panel's record of them — so nothing is orphaned on the host.

## Alerting

The worker evaluates fleet health every three minutes and raises four kinds of alert: a node not reporting, a node under 10% free memory, a server in a crash loop, and backups that are still node-local. Everything is deduplicated on a key, so a node down for an hour is one alert, and anything that recovers resolves itself.

Point `ALERT_WEBHOOK_URL` at a Slack or Discord incoming webhook. Without it, alerts are still recorded and visible at **Admin → Alerts** — you just have to go look.

## Agent updates

Build a new agent bundle, publish it somewhere your nodes can reach, and set three values in `.env`:

```bash
npm run build -w @deers/agent
sha256sum apps/agent/dist/agent.cjs
```

```bash
AGENT_RELEASE_VERSION=1.1.0
AGENT_RELEASE_URL=https://panel.yourdomain.com/downloads/agent-1.1.0.cjs
AGENT_RELEASE_SHA256=<the hash you just printed>
```

Agents check after each reconnect, download, verify the checksum, and refuse to install on a mismatch. The new file is written beside the old one and swapped with a single rename, so a crash mid-write can't leave a broken agent. systemd restarts it. **Running game servers are unaffected** — containers outlive the agent process.

Set `DEERS_AUTO_UPDATE=false` on a node you want to pin.

## If a token leaks

**Admin → Nodes → Rotate token.** The old token stops working immediately, so the node goes offline until you update `/etc/deers/agent.env` and restart the agent. That's intentional — a leaked token should stop being useful the moment you notice.

## Full environment checklist

Control plane `.env`:

| Variable | Needed for |
| --- | --- |
| `DATABASE_URL`, `REDIS_URL` | everything |
| `PUBLIC_GATEWAY_URL`, `PUBLIC_GATEWAY_WS` | agents and browsers connecting |
| `PAYMENT_WEBHOOK_SECRET` | the billing webhook refuses to run without it |
| `DATABASE_HOST_KEY` | per-server databases; back it up separately |
| `ALERT_WEBHOOK_URL` | optional, alert delivery |
| `AGENT_RELEASE_*` | optional, agent auto-update |

Node `/etc/deers/agent.env`:

| Variable | Needed for |
| --- | --- |
| `DEERS_PANEL_URL`, `DEERS_NODE_ID`, `DEERS_NODE_TOKEN` | connecting at all |
| `DEERS_DATA_ROOT`, `DEERS_BACKUP_ROOT`, `DEERS_RUN_AS` | set by the installer |
| `DEERS_S3_*` | off-node backups |
| `DEERS_AUTO_UPDATE` | set to `false` to pin this node |
