#!/bin/bash
# Wrapper script for launchd to start the Minecraft AI dashboard
# This gives us a controlled environment and better error visibility

export HOME=/Users/myroproductions
export SSH_KEY_PATH=/Users/myroproductions/.ssh/id_ed25519
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export NODE_ENV=production

DASHBOARD_DIR="/Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/dashboard"
LOG_DIR="${DASHBOARD_DIR}/logs"
NODE_BIN="/opt/homebrew/bin/node"

# Ensure log directory exists
mkdir -p "${LOG_DIR}"

echo "[$(date)] Starting Minecraft AI Dashboard..." >> "${LOG_DIR}/dashboard.out.log"

cd "${DASHBOARD_DIR}" || { echo "ERROR: Cannot cd to ${DASHBOARD_DIR}" >> "${LOG_DIR}/dashboard.err.log"; exit 1; }

exec "${NODE_BIN}" server.js
