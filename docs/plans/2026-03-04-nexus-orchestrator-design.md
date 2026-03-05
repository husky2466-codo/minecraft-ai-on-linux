# Nexus External Orchestrator — Design Doc
**Date:** 2026-03-04
**Status:** Approved

---

## Overview

Remove Nexus as an in-world Minecraft bot. Replace with a fully autonomous external orchestrator process (`pipeline/nexus-orchestrator.js`) that uses a dedicated eye-bot for vision and two Ollama models on the DGX Spark for perception and reasoning.

---

## Architecture

```
Linux Desktop (10.0.0.10)
├── Minecraft Server :25565
│   ├── Rook, Vex, Drift, Echo, Sage (MindCraft bots)
│   └── NexusEye (mineflayer bot, no AI, fixed elevated position)
├── MindServer :8080 (Socket.io)
└── pipeline/nexus-orchestrator.js
    ├── Socket.io client → MindServer (live agent state)
    ├── mineflayer → NexusEye bot (connect + hold position)
    ├── prismarine-viewer :3099 (headless 3D render of eye-bot POV)
    ├── puppeteer → PNG screenshot of viewer canvas
    └── fs.tail → last 50 lines of ~/mindcraft.log

DGX Spark (10.0.0.69) — Ollama
├── qwen2.5vl:7b  — vision: PNG → world description
└── qwen3.5:27b   — reasoning: description + agent states → directives
```

---

## The 60-Second Loop

Each iteration, in order:

1. **Capture** — puppeteer screenshots prismarine-viewer canvas (in-memory PNG buffer)
2. **See** — `qwen2.5vl:7b` receives PNG, returns 2–3 sentence world description
   - Prompt: *"Describe this Minecraft scene. What are the agents doing? What's been built? Any agents stuck or idle?"*
3. **Read** — agent states from MindServer socket + last 50 log lines from `~/mindcraft.log`
4. **Think** — `qwen3.5:27b` receives:
   - Visual description
   - Per-agent: name, role, position, last action, inventory summary
   - Recent log lines
   - Agent roles: Rook=gather, Vex=combat, Drift=explore, Echo=coordinate, Sage=craft
   - System instruction: *"Issue one directive per agent that is stuck or idle. Prioritize: (1) materials needed, (2) build tasks, (3) exploration. Keep directives short and actionable."*
5. **Act** — parse directives from response, send each via MindServer `send-message` event
6. **Log** — write timestamp + visual summary + directives issued to `~/nexus-orchestrator.log`

**Interval:** 60 seconds (configurable via `NEXUS_INTERVAL_MS` env var)

---

## Eye-Bot (NexusEye)

- **Library:** mineflayer (no AI, no pathfinding plugins)
- **Name:** `NexusEye`
- **Connection:** `10.0.0.10:25565`
- **Position:** Fixed elevated point above spawn area (Y+40 via RCON `/tp` on first connect)
- **Viewer:** prismarine-viewer on port `3099`
- **Auto-reconnect:** yes, on disconnect
- **Behavior:** holds position, renders world, does nothing else

---

## Changes to Existing Code

| File | Change |
|------|--------|
| `mindcraft/settings.js` | Remove `nexus.json` from profiles array |
| `dashboard/server.js` | Remove `nexus_memory` from CHROMA_COLLECTIONS; add nexus-orchestrator to START_CMD and STOP_CMD |
| `pipeline/nexus-orchestrator.js` | **New file** — the orchestrator |
| `pipeline/package.json` | **New file** — dependencies: mineflayer, prismarine-viewer, puppeteer |

---

## Dependencies (pipeline/package.json)

```json
{
  "mineflayer": "^4.x",
  "prismarine-viewer": "^1.x",
  "puppeteer": "^22.x",
  "socket.io-client": "^4.x"
}
```

---

## DGX Setup (one-time)

```bash
ollama pull qwen2.5vl:7b
```

---

## Stack Integration

**START sequence** (after mindcraft + 15s delay):
```bash
cd ~/Projects/minecraft-ai-on-linux
nohup node pipeline/nexus-orchestrator.js > ~/nexus-orchestrator.log 2>&1 &
```

**STOP:** kill by process name lookup on the orchestrator's listener port or by PGID alongside MindCraft stop.

---

## Success Criteria

- Nexus no longer spawns as a Minecraft player
- Eye-bot (NexusEye) visible in-world at elevated position
- Every 60s: a directive log entry appears in `~/nexus-orchestrator.log`
- Agents receive directives via chat and respond
- Dashboard orchestrator panel shows real Nexus log output
- qwen2.5vl:7b and qwen3.5:27b both responding on DGX
