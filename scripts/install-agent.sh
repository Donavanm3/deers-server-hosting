#!/usr/bin/env bash
# Installs the Deers Node Agent on a VPS, dedicated box, or home machine.
# Run as root on the node. The values come from Admin -> Nodes -> Add node.
set -euo pipefail

: "${DEERS_PANEL_URL:?Set DEERS_PANEL_URL (wss://panel.example.com/agent)}"
: "${DEERS_NODE_ID:?Set DEERS_NODE_ID}"
: "${DEERS_NODE_TOKEN:?Set DEERS_NODE_TOKEN}"

command -v docker >/dev/null || { echo "Docker is required. Install it first."; exit 1; }

# Unprivileged account that owns every game server's files.
id -u deers >/dev/null 2>&1 || useradd --system --uid 988 --user-group --no-create-home deers

install -d -o deers -g deers -m 750 /var/lib/deers/servers /var/lib/deers/backups
install -d -m 755 /opt/deers-agent

# The agent needs the Docker socket; it is the only component that does. Customers
# never reach it, because every customer request is authorised by the panel first.
install -d -m 750 /etc/deers
cat > /etc/deers/agent.env <<ENV
DEERS_PANEL_URL=${DEERS_PANEL_URL}
DEERS_NODE_ID=${DEERS_NODE_ID}
DEERS_NODE_TOKEN=${DEERS_NODE_TOKEN}
DEERS_DATA_ROOT=/var/lib/deers/servers
DEERS_BACKUP_ROOT=/var/lib/deers/backups
DEERS_RUN_AS=988:988
ENV
chmod 600 /etc/deers/agent.env

cat > /etc/systemd/system/deers-agent.service <<'UNIT'
[Unit]
Description=Deers Node Agent
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
EnvironmentFile=/etc/deers/agent.env
ExecStart=/usr/bin/node /opt/deers-agent/agent.cjs
Restart=always
RestartSec=5
# The agent survives panel outages on its own, but systemd covers process crashes.
NoNewPrivileges=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=/var/lib/deers

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now deers-agent
echo "Agent installed. It will appear online in the panel within 30 seconds."
