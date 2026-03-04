# Simulation Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a full-stack single-page web dashboard on the Mac Mini that gives complete real-time visibility and control over the Minecraft AI simulation — accessible locally and via Tailscale from an iPad.

**Architecture:** Node.js + Express server runs on Mac Mini (port 4000, reachable at http://10.0.0.223:4000 locally and http://100.85.249.61:4000 via Tailscale). It bridges data from three sources on Linux Desktop (10.0.0.10): MindCraft's MindServer Socket.IO at port 8080 (real-time agent state), SSH for log tailing and file reads, ChromaDB HTTP at port 8000, and RCON at port 25575 for server control. The frontend is a single self-contained HTML file with a sticky sidebar drawer, Chart.js metrics, and live WebSocket updates — no build step.

**Tech Stack:** Node.js 22, Express 4, ws (WebSocket), socket.io-client, ssh2, rcon-client, Chart.js (CDN), vanilla JS/CSS

---

## Machine Reference

| Machine | IP | Tailscale | Role |
|---------|-----|-----------|------|
| Mac Mini | 10.0.0.223 | 100.85.249.61 | Dashboard server (this is where we build) |
| Linux Desktop | 10.0.0.10 | — | Game host — all data lives here |
| DGX | 10.0.0.69 | — | Ollama inference |

**Key Linux Desktop data sources:**
- MindServer Socket.IO: `ws://10.0.0.10:8080` — real-time agent state (position x/y/z, health, hunger, inventory, current action, biome, nearby players)
- mindcraft.log: `~/mindcraft.log` — SSH tail for live events + LLM response time parsing
- Memory files: `~/Projects/minecraft-ai-on-linux/mindcraft/bots/*/memory.json`
- ChromaDB: `http://10.0.0.10:8000` — v2 API (NOT v1, which is deprecated)
- RCON: `10.0.0.10:25575`, password: `ailab743915`
- Minecraft server log: `~/minecraft-server/server.log`

**SSH credentials:**
- Host: `myroproductions@10.0.0.10`
- Key: `/Users/myroproductions/.ssh/id_ed25519`

**All dashboard code goes in:** `/Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/dashboard/`

**5 agent names:** Rook, Vex, Sage, Echo, Drift

---

## MindServer Socket.IO API (Critical Reference)

Connect with `socket.io-client` to `http://10.0.0.10:8080`.

```javascript
// Subscribe to real-time agent state (updates every 1000ms)
socket.emit('listen-to-agents');
socket.on('state-update', (states) => { /* array of full agent state objects */ });

// Get agent list
socket.on('agents-status', (agents) => {
  // agents: [{ name, in_game, viewerPort, socket_connected }]
});

// Control individual agents
socket.emit('restart-agent', agentName);
socket.emit('stop-agent', agentName);
socket.emit('start-agent', agentName);
socket.emit('stop-all-agents');

// Send a chat message to an agent
socket.emit('send-message', agentName, { role: 'user', content: 'message text' });
```

**Full state object per agent (from `state-update` event):**
```javascript
{
  name: "Sage",
  gameplay: {
    position: { x: -533.50, y: 64.00, z: -69.50 },
    dimension: "minecraft:overworld",
    gamemode: "survival",
    health: 20,
    hunger: 20,
    biome: "dark_forest",
    weather: "Clear",
    timeOfDay: 6000,
    timeLabel: "Afternoon"
  },
  action: { current: "Idle", isIdle: true },
  surroundings: { below: "grass_block", legs: "air", head: "air" },
  inventory: {
    counts: { "oak_log": 5, "stone": 3 },
    stacksUsed: 2,
    totalSlots: 36,
    equipment: { helmet: null, chestplate: null, leggings: null, boots: null, mainHand: null }
  },
  nearby: {
    humanPlayers: ["DGXBobAI"],
    botPlayers: ["Rook", "Vex", "Echo", "Drift"],
    entityTypes: []
  }
}
```

---

## ChromaDB v2 API Reference

**Base URL:** `http://10.0.0.10:8000/api/v2`

```
GET  /api/v2/collections                          → list all collections
GET  /api/v2/collections/{name}/get               → get documents (POST with body)
POST /api/v2/collections/{name}/query             → semantic search
     body: { query_texts: ["search term"], n_results: 10 }
GET  /api/v2/collections/{name}                   → collection info + count
```

Collections are named: `rook_memory`, `vex_memory`, `sage_memory`, `echo_memory`, `drift_memory`

---

## Dashboard Sections (Sidebar Navigation)

The sidebar has links that smooth-scroll to each section anchor:
1. **#command-center** — Stack status, start/stop/restart buttons, RCON input
2. **#agents** — 5 live agent cards (position, health, hunger, action, inventory, nearby)
3. **#world-map** — 2D top-down XZ canvas with labeled agent markers
4. **#metrics** — LLM response time chart, commands/min, action type distribution, success rate
5. **#memories** — Per-agent memory.json viewer + ChromaDB search
6. **#logs** — Tabbed live log (mindcraft.log / server.log) with auto-scroll toggle
7. **#remote** — RDP connection info, Tailscale access instructions

---

## Task 1: Project Scaffold — Express Server + Static Serve

**Files:**
- Create: `dashboard/package.json`
- Create: `dashboard/server.js`
- Create: `dashboard/public/index.html` (empty skeleton for now)

**Step 1: Create dashboard directory and package.json**

```bash
mkdir -p /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/dashboard/public
```

`dashboard/package.json`:
```json
{
  "name": "minecraft-sim-dashboard",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "ws": "^8.16.0",
    "socket.io-client": "^4.7.4",
    "ssh2": "^1.15.0",
    "rcon-client": "^4.2.3"
  }
}
```

**Step 2: Install dependencies**

```bash
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/dashboard && npm install
```

Expected: `added XX packages`

**Step 3: Create server.js — Express + WebSocket + static serve**

`dashboard/server.js`:
```javascript
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Broadcast to all connected WebSocket clients
export function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  ws.on('close', () => console.log('[WS] Client disconnected'));
});

const PORT = 4000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard running at http://0.0.0.0:${PORT}`);
  console.log(`Tailscale: http://100.85.249.61:${PORT}`);
});
```

**Step 4: Create public/index.html — bare skeleton**

`dashboard/public/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Minecraft AI Sim Dashboard</title>
</head>
<body>
  <h1>Dashboard Loading...</h1>
  <script>
    const ws = new WebSocket(`ws://${location.host}`);
    ws.onopen = () => document.querySelector('h1').textContent = 'Dashboard Connected';
    ws.onmessage = e => console.log('msg', JSON.parse(e.data));
  </script>
</body>
</html>
```

**Step 5: Verify server starts and WebSocket connects**

```bash
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/dashboard && node server.js &
sleep 2
curl -s http://localhost:4000/api/health
```

Expected: `{"ok":true,"ts":...}`

Open http://localhost:4000 in browser — should show "Dashboard Connected".

**Step 6: Kill test server and commit**

```bash
kill %1
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux
git add dashboard/
git commit -m "feat: dashboard server scaffold with Express + WebSocket"
```

---

## Task 2: MindServer Bridge — Real-Time Agent States

Connect to Socket.IO on Linux Desktop and bridge agent state to dashboard WebSocket clients.

**Files:**
- Create: `dashboard/src/mindserver-bridge.js`
- Modify: `dashboard/server.js`

**Step 1: Create mindserver-bridge.js**

`dashboard/src/mindserver-bridge.js`:
```javascript
import { io } from 'socket.io-client';

const MINDSERVER_URL = 'http://10.0.0.10:8080';

// agentStates: { AgentName: fullStateObject }
export const agentStates = {};
export const agentList = [];

let onUpdateCallback = null;

export function onAgentUpdate(cb) {
  onUpdateCallback = cb;
}

export function startMindServerBridge() {
  const socket = io(MINDSERVER_URL, {
    reconnection: true,
    reconnectionDelay: 3000,
  });

  socket.on('connect', () => {
    console.log('[MindServer] Connected to', MINDSERVER_URL);
    socket.emit('listen-to-agents');
  });

  socket.on('disconnect', () => {
    console.log('[MindServer] Disconnected — will reconnect');
  });

  socket.on('agents-status', (agents) => {
    agentList.length = 0;
    agents.forEach(a => agentList.push(a));
    if (onUpdateCallback) onUpdateCallback('agents-status', agents);
  });

  socket.on('state-update', (states) => {
    // states may be array or object keyed by name
    const arr = Array.isArray(states) ? states : Object.values(states);
    arr.forEach(state => {
      if (state?.name) agentStates[state.name] = state;
    });
    if (onUpdateCallback) onUpdateCallback('agent-states', agentStates);
  });

  socket.on('connect_error', (err) => {
    console.warn('[MindServer] Connection error:', err.message);
  });

  return socket;
}
```

**Step 2: Wire bridge into server.js**

Add to server.js (after imports):
```javascript
import { startMindServerBridge, agentStates, agentList, onAgentUpdate } from './src/mindserver-bridge.js';

// Start bridge
startMindServerBridge();
onAgentUpdate((type, data) => broadcast(type, data));

// REST endpoint for current snapshot
app.get('/api/agents', (req, res) => res.json({ agents: agentStates, list: agentList }));
```

**Step 3: Test the bridge**

```bash
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/dashboard && node server.js &
sleep 5
curl -s http://localhost:4000/api/agents | python3 -m json.tool | head -40
```

Expected: JSON with agent state objects including `gameplay.position`, `action.current`, `inventory`, etc.

**Step 4: Kill test and commit**

```bash
kill %1
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux
git add dashboard/
git commit -m "feat: MindServer Socket.IO bridge for real-time agent states"
```

---

## Task 3: SSH Log Streaming + LLM Metrics Parser

SSH into Linux Desktop, tail mindcraft.log and server.log, stream via WebSocket. Parse log lines for LLM response time metrics.

**Files:**
- Create: `dashboard/src/log-streamer.js`
- Create: `dashboard/src/metrics-engine.js`
- Modify: `dashboard/server.js`

**Step 1: Create log-streamer.js**

`dashboard/src/log-streamer.js`:
```javascript
import { Client } from 'ssh2';

const SSH_CONFIG = {
  host: '10.0.0.10',
  username: 'myroproductions',
  privateKey: (await import('fs')).readFileSync('/Users/myroproductions/.ssh/id_ed25519'),
};

export function tailLog(logPath, onLine) {
  const conn = new Client();
  conn.on('ready', () => {
    conn.exec(`tail -F ${logPath}`, (err, stream) => {
      if (err) { console.error('[SSH]', err.message); return; }
      let buffer = '';
      stream.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line
        lines.forEach(line => { if (line.trim()) onLine(line); });
      });
      stream.on('close', () => {
        console.log('[SSH] Log stream closed, reconnecting in 5s...');
        conn.end();
        setTimeout(() => tailLog(logPath, onLine), 5000);
      });
    });
  });
  conn.on('error', (err) => {
    console.warn('[SSH] Error:', err.message, '— retrying in 5s');
    setTimeout(() => tailLog(logPath, onLine), 5000);
  });
  conn.connect(SSH_CONFIG);
}

export async function readRemoteFile(filePath) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.exec(`cat ${filePath}`, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        let data = '';
        stream.stdout.on('data', chunk => data += chunk);
        stream.on('close', () => { conn.end(); resolve(data); });
      });
    });
    conn.on('error', reject);
    conn.connect(SSH_CONFIG);
  });
}

export async function runRemoteCommand(cmd) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        let stdout = '', stderr = '';
        stream.stdout.on('data', d => stdout += d);
        stream.stderr.on('data', d => stderr += d);
        stream.on('close', (code) => { conn.end(); resolve({ stdout, stderr, code }); });
      });
    });
    conn.on('error', reject);
    conn.connect(SSH_CONFIG);
  });
}
```

**Step 2: Create metrics-engine.js — parse log for LLM timings**

`dashboard/src/metrics-engine.js`:
```javascript
// Rolling metrics per agent
export const metrics = {
  responseTimes: {}, // { AgentName: [{ ts, ms }, ...] } (last 50)
  commandCounts: {},  // { AgentName: { commandName: count } }
  actionResults: {},  // { AgentName: { success: N, fail: N } }
  totalCalls: {},     // { AgentName: N }
  lastActivity: {},   // { AgentName: timestamp }
};

const pendingTimers = {}; // { AgentName: startTs }

const AGENTS = ['Rook', 'Vex', 'Sage', 'Echo', 'Drift'];

AGENTS.forEach(name => {
  metrics.responseTimes[name] = [];
  metrics.commandCounts[name] = {};
  metrics.actionResults[name] = { success: 0, fail: 0 };
  metrics.totalCalls[name] = 0;
  metrics.lastActivity[name] = null;
});

export function parseMindcraftLine(line) {
  const ts = Date.now();

  // Detect LLM call start: "Awaiting local response..."
  if (line.includes('Awaiting local response')) {
    // Which agent? Previous lines set context — use last known agent from "full response" pattern
    // Store pending timer with line context
    pendingTimers['_pending'] = ts;
    return null;
  }

  // Detect LLM call end: "AgentName full response to system:"
  const responseMatch = line.match(/^(\w+) full response to system:/);
  if (responseMatch) {
    const agent = responseMatch[1];
    if (pendingTimers['_pending'] && AGENTS.includes(agent)) {
      const ms = ts - pendingTimers['_pending'];
      metrics.responseTimes[agent].push({ ts, ms });
      if (metrics.responseTimes[agent].length > 50) metrics.responseTimes[agent].shift();
      metrics.totalCalls[agent]++;
      metrics.lastActivity[agent] = ts;
      delete pendingTimers['_pending'];
      return { type: 'response-time', agent, ms };
    }
  }

  // Detect command execution: "parsed command: { commandName: '!xxx', args: [...] }"
  const cmdMatch = line.match(/commandName: '(![\w]+)'/);
  if (cmdMatch) {
    // Find which agent — look for agent name in recent context
    // Best effort: extract from preceding line pattern or use last agent
    const cmd = cmdMatch[1];
    for (const agent of AGENTS) {
      if (pendingTimers[agent + '_cmd'] || metrics.lastActivity[agent]) {
        metrics.commandCounts[agent][cmd] = (metrics.commandCounts[agent][cmd] || 0) + 1;
        break;
      }
    }
    return { type: 'command', cmd };
  }

  // Detect success/fail: "Agent executed: X and got: Action output:"
  const successMatch = line.match(/Agent executed: (![\w]+) and got: Action output:/);
  const failMatch = line.match(/Agent executed: (![\w]+) and got:.*[Cc]ould not|[Ff]ail/);

  return null;
}
```

**Step 3: Wire into server.js**

Add to server.js:
```javascript
import { tailLog, readRemoteFile, runRemoteCommand } from './src/log-streamer.js';
import { parseMindcraftLine, metrics } from './src/metrics-engine.js';

// Tail mindcraft log
tailLog('/home/myroproductions/mindcraft.log', (line) => {
  const parsed = parseMindcraftLine(line);
  if (parsed) broadcast('metric-update', parsed);
  broadcast('log-line', { source: 'mindcraft', line });
});

// Tail minecraft server log
tailLog('/home/myroproductions/minecraft-server/server.log', (line) => {
  broadcast('log-line', { source: 'minecraft', line });
});

// Metrics endpoint
app.get('/api/metrics', (req, res) => res.json(metrics));
```

**Step 4: Test log streaming**

```bash
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/dashboard && node server.js &
sleep 3
# Verify logs are streaming
curl -s http://localhost:4000/api/metrics
```

Expected: JSON with `responseTimes`, `commandCounts`, `totalCalls` per agent.

**Step 5: Kill and commit**

```bash
kill %1
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux
git add dashboard/
git commit -m "feat: SSH log streaming and LLM metrics parser"
```

---

## Task 4: Data APIs — Memory Files, ChromaDB, RCON Control

**Files:**
- Create: `dashboard/src/rcon-client.js`
- Modify: `dashboard/server.js`

**Step 1: Create rcon-client.js**

`dashboard/src/rcon-client.js`:
```javascript
import { Rcon } from 'rcon-client';

const rcon = new Rcon({ host: '10.0.0.10', port: 25575, password: 'ailab743915' });
let connected = false;

async function ensureConnected() {
  if (!connected) {
    await rcon.connect();
    connected = true;
    rcon.socket.on('close', () => { connected = false; });
  }
}

export async function sendRcon(command) {
  await ensureConnected();
  return rcon.send(command);
}
```

**Step 2: Add REST API routes to server.js**

```javascript
import { sendRcon } from './src/rcon-client.js';
import { readRemoteFile, runRemoteCommand } from './src/log-streamer.js';

const AGENTS = ['Rook', 'Vex', 'Sage', 'Echo', 'Drift'];
const MINDCRAFT_PATH = '/home/myroproductions/Projects/minecraft-ai-on-linux/mindcraft';
const LINUX = 'myroproductions@10.0.0.10';

// --- Memory files ---
app.get('/api/memories/:agent', async (req, res) => {
  const { agent } = req.params;
  if (!AGENTS.includes(agent)) return res.status(404).json({ error: 'Unknown agent' });
  try {
    const content = await readRemoteFile(`${MINDCRAFT_PATH}/bots/${agent}/memory.json`);
    res.json(JSON.parse(content));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- ChromaDB proxy (v2 API) ---
const CHROMA = 'http://10.0.0.10:8000/api/v2';

app.get('/api/chromadb/collections', async (req, res) => {
  const r = await fetch(`${CHROMA}/collections`);
  res.json(await r.json());
});

app.post('/api/chromadb/search', async (req, res) => {
  const { collection, query, n = 10 } = req.body;
  const r = await fetch(`${CHROMA}/collections/${collection}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query_texts: [query], n_results: n }),
  });
  res.json(await r.json());
});

app.get('/api/chromadb/:collection', async (req, res) => {
  const r = await fetch(`${CHROMA}/collections/${req.params.collection}/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 50 }),
  });
  res.json(await r.json());
});

// --- RCON ---
app.post('/api/rcon', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  try {
    const result = await sendRcon(command);
    res.json({ result: result || '(no output)' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Stack control ---
app.post('/api/control/:action', async (req, res) => {
  const { action } = req.params;
  const PROJECT = '/home/myroproductions/Projects/minecraft-ai-on-linux';
  const NODE = '$HOME/.nvm/versions/node/v22.22.0/bin/node';
  const CMDS = {
    start: `cd ${PROJECT} && bash pipeline/start_stack.sh && PATH=$HOME/.nvm/versions/node/v22.22.0/bin:$HOME/.local/bin:$PATH nohup node mindcraft/main.js > ~/mindcraft.log 2>&1 &`,
    stop: `cd ${PROJECT} && bash pipeline/stop_stack.sh`,
    restart: `cd ${PROJECT} && bash pipeline/stop_stack.sh; sleep 5; bash pipeline/start_stack.sh && PATH=$HOME/.nvm/versions/node/v22.22.0/bin:$HOME/.local/bin:$PATH nohup node mindcraft/main.js > ~/mindcraft.log 2>&1 &`,
  };
  if (!CMDS[action]) return res.status(400).json({ error: 'Unknown action' });
  try {
    const { stdout, stderr } = await runRemoteCommand(CMDS[action]);
    res.json({ ok: true, stdout, stderr });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Agent control (via MindServer socket) ---
// Expose via REST, bridge to socket emit
app.post('/api/agents/:name/:action', (req, res) => {
  const { name, action } = req.params;
  const { mindServerSocket } = req.app.locals;
  if (!mindServerSocket) return res.status(503).json({ error: 'MindServer not connected' });
  const validActions = ['restart-agent', 'stop-agent', 'start-agent'];
  if (!validActions.includes(action + '-agent')) return res.status(400).json({ error: 'Invalid action' });
  mindServerSocket.emit(`${action}-agent`, name);
  res.json({ ok: true });
});
```

**Step 3: Export the mindServerSocket from bridge so it's accessible**

Modify `dashboard/src/mindserver-bridge.js` to return the socket:
```javascript
// Change startMindServerBridge() to return socket
export function startMindServerBridge() {
  const socket = io(MINDSERVER_URL, { ... });
  // ... same as before ...
  return socket;  // already does this
}
```

In `server.js`:
```javascript
const mindServerSocket = startMindServerBridge();
app.locals.mindServerSocket = mindServerSocket;
```

**Step 4: Test all API endpoints**

```bash
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/dashboard && node server.js &
sleep 3

# Test memory endpoint
curl -s http://localhost:4000/api/memories/Sage | python3 -m json.tool | head -20

# Test ChromaDB
curl -s http://localhost:4000/api/chromadb/collections | python3 -m json.tool

# Test RCON
curl -s -X POST http://localhost:4000/api/rcon -H 'Content-Type: application/json' \
  -d '{"command":"list"}' | python3 -m json.tool
```

Expected:
- Memory: JSON with `memory`, `turns`, `self_prompt` fields
- ChromaDB: list of 5 collections
- RCON: `{"result": "There are X of a max of 10 players online..."}`

**Step 5: Kill and commit**

```bash
kill %1
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux
git add dashboard/
git commit -m "feat: memory, ChromaDB proxy, RCON, and stack control API endpoints"
```

---

## Task 5: Frontend — Full Single-Page Dashboard HTML

This is the bulk of the UI. All in one file: `dashboard/public/index.html`.

**Files:**
- Overwrite: `dashboard/public/index.html`

The page has:
- Sticky left sidebar with nav links to each section
- 7 sections in a scrollable main area
- Dark theme (`#0f1117` background, `#1e2130` cards)
- Live WebSocket updates to all dynamic fields
- Chart.js loaded from CDN

**Step 1: Write index.html**

Full file content:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Minecraft AI Sim — Control Center</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  /* ===== RESET & BASE ===== */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0f1117;
    --card: #1e2130;
    --card2: #252840;
    --border: #2e3250;
    --accent: #5b6af5;
    --accent2: #00c8a0;
    --warn: #f5a623;
    --danger: #e84040;
    --text: #e8eaf6;
    --muted: #7b82a8;
    --sidebar-w: 200px;
    --rook: #e57373;
    --vex: #ff8a65;
    --sage: #81c784;
    --echo: #64b5f6;
    --drift: #ce93d8;
  }
  body {
    font-family: 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    display: flex;
    min-height: 100vh;
  }

  /* ===== SIDEBAR ===== */
  #sidebar {
    width: var(--sidebar-w);
    background: var(--card);
    border-right: 1px solid var(--border);
    position: fixed;
    top: 0; left: 0; bottom: 0;
    display: flex;
    flex-direction: column;
    padding: 20px 0;
    z-index: 100;
    overflow-y: auto;
  }
  #sidebar .logo {
    padding: 0 16px 20px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 12px;
  }
  #sidebar .logo h2 {
    font-size: 13px;
    font-weight: 700;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 1px;
  }
  #sidebar .logo .status-dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--danger);
    margin-right: 6px;
    transition: background .3s;
  }
  #sidebar .logo .status-dot.connected { background: var(--accent2); }
  #sidebar nav a {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    color: var(--muted);
    text-decoration: none;
    font-size: 13px;
    font-weight: 500;
    border-left: 3px solid transparent;
    transition: all .15s;
  }
  #sidebar nav a:hover, #sidebar nav a.active {
    color: var(--text);
    background: var(--card2);
    border-left-color: var(--accent);
  }
  #sidebar nav a .icon { font-size: 16px; width: 20px; text-align: center; }
  #sidebar .server-status {
    margin-top: auto;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--muted);
  }
  #sidebar .server-status .pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 600;
    font-size: 10px;
    background: var(--card2);
  }
  #sidebar .server-status .pill.up { color: var(--accent2); }
  #sidebar .server-status .pill.down { color: var(--danger); }

  /* ===== MAIN CONTENT ===== */
  #main {
    margin-left: var(--sidebar-w);
    flex: 1;
    padding: 32px 40px;
    max-width: 1400px;
  }
  section {
    margin-bottom: 64px;
  }
  section h2 {
    font-size: 20px;
    font-weight: 700;
    margin-bottom: 20px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  section h2 .section-icon { font-size: 22px; }

  /* ===== CARDS ===== */
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px;
  }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .grid-5 { display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; }
  @media (max-width: 1200px) {
    .grid-5 { grid-template-columns: repeat(3, 1fr); }
    .grid-3 { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 800px) {
    .grid-5, .grid-3, .grid-2 { grid-template-columns: 1fr; }
    #main { padding: 16px 20px; }
  }

  /* ===== BUTTONS ===== */
  .btn {
    padding: 8px 18px;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity .15s;
  }
  .btn:hover { opacity: .85; }
  .btn:active { opacity: .7; }
  .btn-primary { background: var(--accent); color: white; }
  .btn-success { background: var(--accent2); color: #0f1117; }
  .btn-danger { background: var(--danger); color: white; }
  .btn-warn { background: var(--warn); color: #0f1117; }
  .btn-ghost {
    background: var(--card2);
    color: var(--text);
    border: 1px solid var(--border);
  }
  .btn-sm { padding: 4px 10px; font-size: 11px; }

  /* ===== COMMAND CENTER ===== */
  .control-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }
  .control-panel {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px;
  }
  .control-panel h3 {
    font-size: 14px;
    font-weight: 700;
    margin-bottom: 14px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: .5px;
  }
  .stack-buttons { display: flex; gap: 10px; flex-wrap: wrap; }
  .rcon-input { display: flex; gap: 8px; margin-top: 12px; }
  .rcon-input input {
    flex: 1;
    background: var(--card2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    padding: 8px 12px;
    font-family: monospace;
    font-size: 13px;
  }
  .rcon-input input:focus { outline: none; border-color: var(--accent); }
  .rcon-output {
    margin-top: 10px;
    background: var(--card2);
    border-radius: 6px;
    padding: 10px 12px;
    font-family: monospace;
    font-size: 12px;
    color: var(--accent2);
    min-height: 36px;
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* ===== STAT ITEMS ===== */
  .stat-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .stat-item:last-child { border-bottom: none; }
  .stat-label { color: var(--muted); }
  .stat-value { font-weight: 600; font-family: monospace; }

  /* ===== AGENT CARDS ===== */
  .agent-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    position: relative;
    overflow: hidden;
  }
  .agent-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
  }
  .agent-card[data-agent="Rook"]::before { background: var(--rook); }
  .agent-card[data-agent="Vex"]::before { background: var(--vex); }
  .agent-card[data-agent="Sage"]::before { background: var(--sage); }
  .agent-card[data-agent="Echo"]::before { background: var(--echo); }
  .agent-card[data-agent="Drift"]::before { background: var(--drift); }
  .agent-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  .agent-name { font-size: 16px; font-weight: 700; }
  .agent-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--card2);
    color: var(--muted);
    text-transform: uppercase;
  }
  .agent-pos {
    font-family: monospace;
    font-size: 11px;
    color: var(--accent2);
    margin-bottom: 10px;
  }
  .agent-action {
    font-size: 12px;
    color: var(--warn);
    margin-bottom: 10px;
    min-height: 16px;
  }
  .health-bar-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    font-size: 11px;
    color: var(--muted);
  }
  .bar {
    flex: 1;
    height: 6px;
    background: var(--card2);
    border-radius: 3px;
    overflow: hidden;
  }
  .bar-fill { height: 100%; border-radius: 3px; transition: width .5s; }
  .bar-health .bar-fill { background: #4caf50; }
  .bar-hunger .bar-fill { background: var(--warn); }
  .agent-inv {
    font-size: 11px;
    color: var(--muted);
    margin-top: 8px;
    font-family: monospace;
    max-height: 60px;
    overflow-y: auto;
  }
  .agent-nearby {
    font-size: 11px;
    color: var(--muted);
    margin-top: 6px;
  }
  .agent-status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--danger);
    display: inline-block;
    margin-right: 4px;
  }
  .agent-status-dot.online { background: var(--accent2); }
  .agent-controls { display: flex; gap: 6px; margin-top: 10px; }

  /* ===== WORLD MAP ===== */
  #world-map-canvas {
    width: 100%;
    height: 500px;
    background: var(--card2);
    border-radius: 8px;
    cursor: crosshair;
  }
  .map-legend {
    display: flex;
    gap: 16px;
    margin-top: 12px;
    flex-wrap: wrap;
  }
  .map-legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .legend-dot {
    width: 12px; height: 12px;
    border-radius: 50%;
  }

  /* ===== METRICS ===== */
  .metrics-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }
  .chart-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px;
  }
  .chart-card h3 {
    font-size: 13px;
    font-weight: 700;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: .5px;
    margin-bottom: 16px;
  }
  .chart-card canvas { max-height: 240px; }
  .stat-row {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 12px;
    margin-bottom: 20px;
  }
  .stat-box {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    text-align: center;
  }
  .stat-box .val {
    font-size: 28px;
    font-weight: 700;
    font-family: monospace;
    color: var(--accent);
  }
  .stat-box .lbl {
    font-size: 11px;
    color: var(--muted);
    margin-top: 4px;
    text-transform: uppercase;
    letter-spacing: .5px;
  }

  /* ===== MEMORIES ===== */
  .memory-tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 4px;
  }
  .memory-tab {
    padding: 6px 14px;
    border: none;
    background: none;
    color: var(--muted);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border-radius: 6px 6px 0 0;
    transition: all .15s;
  }
  .memory-tab.active {
    background: var(--card);
    color: var(--text);
  }
  .memory-panel { display: none; }
  .memory-panel.active { display: block; }
  .memory-summary {
    background: var(--card2);
    border-radius: 6px;
    padding: 12px;
    font-size: 13px;
    margin-bottom: 12px;
    line-height: 1.6;
    min-height: 60px;
  }
  .memory-turns {
    max-height: 400px;
    overflow-y: auto;
  }
  .turn {
    padding: 8px 12px;
    margin-bottom: 6px;
    border-radius: 6px;
    font-size: 12px;
    line-height: 1.5;
  }
  .turn.system { background: #1a1f35; border-left: 3px solid var(--muted); }
  .turn.assistant { background: #1a2535; border-left: 3px solid var(--accent); }
  .turn.user { background: #1a2520; border-left: 3px solid var(--accent2); }
  .turn-role {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 4px;
  }

  /* ChromaDB Search */
  .chroma-search {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .chroma-search input, .chroma-search select {
    background: var(--card2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    padding: 8px 12px;
    font-size: 13px;
  }
  .chroma-search input { flex: 1; min-width: 200px; }
  .chroma-search input:focus, .chroma-search select:focus {
    outline: none; border-color: var(--accent);
  }
  .chroma-results { max-height: 400px; overflow-y: auto; }
  .chroma-result {
    background: var(--card2);
    border-radius: 6px;
    padding: 10px 12px;
    margin-bottom: 8px;
    font-size: 12px;
    line-height: 1.5;
  }
  .chroma-result .dist {
    font-size: 10px;
    color: var(--muted);
    float: right;
  }

  /* ===== LOGS ===== */
  .log-tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 12px;
  }
  .log-tab {
    padding: 6px 14px;
    border: 1px solid var(--border);
    background: var(--card2);
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    border-radius: 6px;
    transition: all .15s;
  }
  .log-tab.active {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }
  .log-controls {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
    align-items: center;
  }
  .log-filter {
    background: var(--card2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    padding: 6px 10px;
    font-size: 12px;
    width: 200px;
  }
  .log-box {
    background: #080a10;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px;
    height: 500px;
    overflow-y: auto;
    font-family: 'Cascadia Code', 'Fira Code', monospace;
    font-size: 11px;
    line-height: 1.6;
  }
  .log-line { padding: 1px 0; }
  .log-line.error { color: var(--danger); }
  .log-line.warn { color: var(--warn); }
  .log-line.success { color: var(--accent2); }
  .log-line.info { color: var(--muted); }
  .log-line.response { color: #c5e1a5; }
  .log-line.command { color: #b3e5fc; }

  /* ===== REMOTE ===== */
  .remote-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .rdp-info {
    font-family: monospace;
    font-size: 13px;
    line-height: 2;
  }
  .rdp-info .lbl { color: var(--muted); font-family: sans-serif; font-size: 11px; }
  code {
    background: var(--card2);
    padding: 2px 6px;
    border-radius: 4px;
    font-family: monospace;
  }

  /* ===== MISC ===== */
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .badge-online { background: #1a3a2a; color: var(--accent2); }
  .badge-offline { background: #3a1a1a; color: var(--danger); }
  .badge-idle { background: #2a2a3a; color: var(--muted); }

  /* scrollbar */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: var(--card2); }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
</style>
</head>
<body>

<!-- ===== SIDEBAR ===== -->
<nav id="sidebar">
  <div class="logo">
    <div>
      <span class="status-dot" id="ws-dot"></span>
      <span style="font-size:11px;color:var(--muted)" id="ws-status">Connecting...</span>
    </div>
    <h2 style="margin-top:6px">MC AI Lab</h2>
  </div>
  <nav>
    <a href="#command-center" class="active"><span class="icon">⚡</span>Command Center</a>
    <a href="#agents"><span class="icon">🤖</span>Agents</a>
    <a href="#world-map"><span class="icon">🗺️</span>World Map</a>
    <a href="#metrics"><span class="icon">📊</span>Metrics</a>
    <a href="#memories"><span class="icon">🧠</span>Memories</a>
    <a href="#logs"><span class="icon">📋</span>Live Logs</a>
    <a href="#remote"><span class="icon">🔗</span>Remote Access</a>
  </nav>
  <div class="server-status">
    <div>MC Server <span class="pill" id="mc-pill">—</span></div>
    <div style="margin-top:6px">ChromaDB <span class="pill" id="chroma-pill">—</span></div>
    <div style="margin-top:6px">MindServer <span class="pill" id="mind-pill">—</span></div>
  </div>
</nav>

<!-- ===== MAIN ===== -->
<main id="main">

  <!-- 1. COMMAND CENTER -->
  <section id="command-center">
    <h2><span class="section-icon">⚡</span>Command Center</h2>
    <div class="control-grid">
      <div class="control-panel">
        <h3>Stack Control</h3>
        <div class="stack-buttons">
          <button class="btn btn-success" onclick="stackControl('start')">▶ Start All</button>
          <button class="btn btn-danger" onclick="stackControl('stop')">■ Stop All</button>
          <button class="btn btn-warn" onclick="stackControl('restart')">↺ Restart</button>
        </div>
        <div id="control-output" class="rcon-output" style="margin-top:14px"></div>
      </div>
      <div class="control-panel">
        <h3>RCON Console</h3>
        <div class="rcon-input">
          <input id="rcon-input" type="text" placeholder="e.g. list, give Rook diamond 5, time set day" />
          <button class="btn btn-primary" onclick="sendRcon()">Send</button>
        </div>
        <div id="rcon-output" class="rcon-output"></div>
      </div>
      <div class="control-panel">
        <h3>Server Info</h3>
        <div id="server-info">
          <div class="stat-item"><span class="stat-label">MC Host</span><span class="stat-value">10.0.0.10:25565</span></div>
          <div class="stat-item"><span class="stat-label">DGX Ollama</span><span class="stat-value">10.0.0.69:11434</span></div>
          <div class="stat-item"><span class="stat-label">ChromaDB</span><span class="stat-value">10.0.0.10:8000</span></div>
          <div class="stat-item"><span class="stat-label">MindServer</span><span class="stat-value">10.0.0.10:8080</span></div>
          <div class="stat-item"><span class="stat-label">Dashboard</span><span class="stat-value">:4000 / Tailscale :4000</span></div>
        </div>
      </div>
      <div class="control-panel">
        <h3>Agent Controls</h3>
        <div id="agent-quick-controls">
          <!-- populated by JS -->
        </div>
      </div>
    </div>
  </section>

  <!-- 2. AGENTS -->
  <section id="agents">
    <h2><span class="section-icon">🤖</span>Live Agents</h2>
    <div class="grid-5" id="agent-cards">
      <!-- populated by JS -->
    </div>
  </section>

  <!-- 3. WORLD MAP -->
  <section id="world-map">
    <h2><span class="section-icon">🗺️</span>World Map (XZ Plane)</h2>
    <div class="card">
      <canvas id="world-map-canvas"></canvas>
      <div class="map-legend" id="map-legend"></div>
    </div>
  </section>

  <!-- 4. METRICS -->
  <section id="metrics">
    <h2><span class="section-icon">📊</span>AI Metrics</h2>
    <div class="stat-row" id="total-stats">
      <!-- populated by JS -->
    </div>
    <div class="metrics-grid">
      <div class="chart-card">
        <h3>LLM Response Time (ms) — Last 50 calls</h3>
        <canvas id="chart-response-time"></canvas>
      </div>
      <div class="chart-card">
        <h3>Commands Issued by Agent</h3>
        <canvas id="chart-commands"></canvas>
      </div>
      <div class="chart-card">
        <h3>Total API Calls Per Agent</h3>
        <canvas id="chart-calls"></canvas>
      </div>
      <div class="chart-card">
        <h3>Command Type Distribution</h3>
        <canvas id="chart-cmd-types"></canvas>
      </div>
    </div>
  </section>

  <!-- 5. MEMORIES -->
  <section id="memories">
    <h2><span class="section-icon">🧠</span>Agent Memories</h2>
    <div class="memory-tabs" id="memory-tabs">
      <button class="memory-tab active" onclick="switchMemTab(this,'Rook')">Rook</button>
      <button class="memory-tab" onclick="switchMemTab(this,'Vex')">Vex</button>
      <button class="memory-tab" onclick="switchMemTab(this,'Sage')">Sage</button>
      <button class="memory-tab" onclick="switchMemTab(this,'Echo')">Echo</button>
      <button class="memory-tab" onclick="switchMemTab(this,'Drift')">Drift</button>
      <button class="memory-tab" onclick="switchMemTab(this,'_chroma')" style="margin-left:20px">🔍 ChromaDB Search</button>
    </div>
    <div id="mem-panels">
      <!-- populated by JS -->
    </div>
  </section>

  <!-- 6. LOGS -->
  <section id="logs">
    <h2><span class="section-icon">📋</span>Live Logs</h2>
    <div class="log-tabs">
      <button class="log-tab active" onclick="switchLogTab(this,'mindcraft')">MindCraft Log</button>
      <button class="log-tab" onclick="switchLogTab(this,'minecraft')">Minecraft Server</button>
    </div>
    <div class="log-controls">
      <input type="text" class="log-filter" id="log-filter" placeholder="Filter lines..." oninput="applyLogFilter()">
      <button class="btn btn-ghost btn-sm" onclick="toggleAutoScroll()">Auto-scroll: <span id="scroll-label">ON</span></button>
      <button class="btn btn-ghost btn-sm" onclick="clearLogs()">Clear</button>
    </div>
    <div class="log-box" id="log-box"></div>
  </section>

  <!-- 7. REMOTE -->
  <section id="remote">
    <h2><span class="section-icon">🔗</span>Remote Access</h2>
    <div class="remote-grid">
      <div class="card">
        <h3 style="margin-bottom:14px;font-size:14px">RDP — Linux Desktop</h3>
        <div class="rdp-info">
          <div class="lbl">HOST</div>
          <code>10.0.0.10</code> (local) / check Tailscale for remote
          <div class="lbl" style="margin-top:10px">PORT</div>
          <code>3389</code>
          <div class="lbl" style="margin-top:10px">USER</div>
          <code>myroproductions</code>
          <div class="lbl" style="margin-top:10px">iPad App</div>
          Microsoft Remote Desktop (App Store)
          <div style="margin-top:14px;font-size:11px;color:var(--muted)">
            Note: xrdp must be installed on Linux Desktop.<br>
            <code>sudo apt install xrdp</code>
          </div>
        </div>
      </div>
      <div class="card">
        <h3 style="margin-bottom:14px;font-size:14px">Tailscale Access</h3>
        <div class="rdp-info">
          <div class="lbl">DASHBOARD (Mac Mini)</div>
          <code>http://100.85.249.61:4000</code>
          <div class="lbl" style="margin-top:10px">SSH — Linux Desktop</div>
          <code>ssh myroproductions@10.0.0.10</code><br>
          (via local network or Tailscale exit node)
          <div class="lbl" style="margin-top:10px">SSH — DGX</div>
          <code>ssh nmyers@10.0.0.69</code>
          <div class="lbl" style="margin-top:10px">Mac Mini Tailscale IP</div>
          <code>100.85.249.61</code>
        </div>
      </div>
    </div>
  </section>

</main>

<script>
// ===== CONFIG =====
const AGENTS = ['Rook', 'Vex', 'Sage', 'Echo', 'Drift'];
const AGENT_COLORS = { Rook: '#e57373', Vex: '#ff8a65', Sage: '#81c784', Echo: '#64b5f6', Drift: '#ce93d8' };
const FOCUS = { Rook: 'builder', Vex: 'fighter', Sage: 'engineer', Echo: 'diplomat', Drift: 'explorer' };

// ===== STATE =====
let agentStates = {};
let metrics = { responseTimes: {}, commandCounts: {}, totalCalls: {}, lastActivity: {} };
let logLines = { mindcraft: [], minecraft: [] };
let activeLogTab = 'mindcraft';
let autoScroll = true;
let activeMemTab = 'Rook';
let charts = {};

// ===== WEBSOCKET =====
const ws = new WebSocket(`ws://${location.host}`);
ws.onopen = () => {
  document.getElementById('ws-dot').classList.add('connected');
  document.getElementById('ws-status').textContent = 'Live';
  loadInitialData();
};
ws.onclose = () => {
  document.getElementById('ws-dot').classList.remove('connected');
  document.getElementById('ws-status').textContent = 'Disconnected';
  setTimeout(() => location.reload(), 5000);
};
ws.onmessage = e => {
  const { type, data } = JSON.parse(e.data);
  if (type === 'agent-states') handleAgentStates(data);
  if (type === 'agents-status') updateMindPill(true);
  if (type === 'metric-update') handleMetricUpdate(data);
  if (type === 'log-line') appendLogLine(data.source, data.line);
};

// ===== INIT =====
async function loadInitialData() {
  // Agent states
  const r = await fetch('/api/agents');
  const d = await r.json();
  if (d.agents) handleAgentStates(d.agents);

  // Metrics
  const mr = await fetch('/api/metrics');
  metrics = await mr.json();
  updateCharts();
  updateTotalStats();

  // Status pills
  checkStatus();
  setInterval(checkStatus, 15000);
  setInterval(updateCharts, 5000);
  setInterval(updateTotalStats, 5000);
}

async function checkStatus() {
  // MC server via RCON list
  try {
    const r = await fetch('/api/rcon', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({command:'list'}) });
    const d = await r.json();
    const pill = document.getElementById('mc-pill');
    if (d.result) { pill.textContent = 'UP'; pill.className = 'pill up'; }
  } catch { document.getElementById('mc-pill').textContent = 'DOWN'; document.getElementById('mc-pill').className = 'pill down'; }

  // ChromaDB
  try {
    const r = await fetch('/api/chromadb/collections');
    const d = await r.json();
    const pill = document.getElementById('chroma-pill');
    if (Array.isArray(d)) { pill.textContent = 'UP'; pill.className = 'pill up'; }
  } catch { document.getElementById('chroma-pill').textContent = 'DOWN'; document.getElementById('chroma-pill').className = 'pill down'; }
}

function updateMindPill(connected) {
  const pill = document.getElementById('mind-pill');
  pill.textContent = connected ? 'UP' : 'DOWN';
  pill.className = 'pill ' + (connected ? 'up' : 'down');
}

// ===== AGENT CARDS =====
function handleAgentStates(states) {
  agentStates = states;
  renderAgentCards();
  renderWorldMap();
  renderAgentQuickControls();
}

function renderAgentCards() {
  const container = document.getElementById('agent-cards');
  container.innerHTML = '';
  AGENTS.forEach(name => {
    const state = agentStates[name];
    const card = document.createElement('div');
    card.className = 'agent-card';
    card.setAttribute('data-agent', name);

    const pos = state?.gameplay?.position;
    const posStr = pos ? `X:${pos.x.toFixed(1)} Y:${pos.y.toFixed(1)} Z:${pos.z.toFixed(1)}` : 'Unknown';
    const health = state?.gameplay?.health ?? 0;
    const hunger = state?.gameplay?.hunger ?? 0;
    const action = state?.action?.current ?? 'Unknown';
    const isIdle = state?.action?.isIdle ?? true;
    const biome = state?.gameplay?.biome ?? '—';
    const inv = state?.inventory?.counts ?? {};
    const invStr = Object.entries(inv).filter(([,v])=>v>0).map(([k,v])=>`${k}×${v}`).join(', ') || 'Empty';
    const nearby = state?.nearby?.humanPlayers ?? [];
    const bots = state?.nearby?.botPlayers ?? [];
    const online = !!state;
    const hp = (health/20*100).toFixed(0);
    const hg = (hunger/20*100).toFixed(0);

    card.innerHTML = `
      <div class="agent-header">
        <div>
          <span class="agent-status-dot ${online ? 'online' : ''}"></span>
          <span class="agent-name">${name}</span>
        </div>
        <span class="agent-badge">${FOCUS[name]}</span>
      </div>
      <div class="agent-pos">${posStr}</div>
      <div class="agent-action">${isIdle ? '💤 Idle' : '⚡ ' + action}</div>
      <div class="health-bar-wrap">
        ❤️
        <div class="bar bar-health"><div class="bar-fill" style="width:${hp}%"></div></div>
        <span>${health}/20</span>
      </div>
      <div class="health-bar-wrap">
        🍗
        <div class="bar bar-hunger"><div class="bar-fill" style="width:${hg}%"></div></div>
        <span>${hunger}/20</span>
      </div>
      <div class="agent-inv">📦 ${invStr.slice(0,120)}</div>
      <div class="agent-nearby">🌿 ${biome} ${nearby.length ? '| 👤 ' + nearby.join(', ') : ''}</div>
      <div class="agent-controls">
        <button class="btn btn-ghost btn-sm" onclick="agentAction('${name}','restart')">↺</button>
        <button class="btn btn-ghost btn-sm" onclick="agentAction('${name}','stop')">■</button>
        <button class="btn btn-ghost btn-sm" onclick="loadMemory('${name}')">🧠</button>
      </div>
    `;
    container.appendChild(card);
  });
}

// ===== AGENT QUICK CONTROLS =====
function renderAgentQuickControls() {
  const el = document.getElementById('agent-quick-controls');
  el.innerHTML = AGENTS.map(name => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:13px;font-weight:600;color:${AGENT_COLORS[name]}">${name}</span>
      <div style="display:flex;gap:6px">
        <button class="btn btn-ghost btn-sm" onclick="agentAction('${name}','start')">▶</button>
        <button class="btn btn-ghost btn-sm" onclick="agentAction('${name}','restart')">↺</button>
        <button class="btn btn-ghost btn-sm" onclick="agentAction('${name}','stop')">■</button>
      </div>
    </div>
  `).join('');
}

// ===== WORLD MAP =====
function renderWorldMap() {
  const canvas = document.getElementById('world-map-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;

  const W = canvas.width, H = canvas.height;

  // Get positions
  const positions = AGENTS.map(name => {
    const p = agentStates[name]?.gameplay?.position;
    return p ? { name, x: p.x, z: p.z } : null;
  }).filter(Boolean);

  if (positions.length === 0) {
    ctx.fillStyle = '#7b82a8';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for agent positions...', W/2, H/2);
    return;
  }

  // Compute bounds with padding
  const xs = positions.map(p => p.x), zs = positions.map(p => p.z);
  const pad = 50;
  let minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  let minZ = Math.min(...zs) - pad, maxZ = Math.max(...zs) + pad;
  // Ensure minimum view range
  if (maxX - minX < 100) { const c = (maxX+minX)/2; minX = c-50; maxX = c+50; }
  if (maxZ - minZ < 100) { const c = (maxZ+minZ)/2; minZ = c-50; maxZ = c+50; }

  const toCanvas = (wx, wz) => ({
    cx: (wx - minX) / (maxX - minX) * (W - 60) + 30,
    cy: (wz - minZ) / (maxZ - minZ) * (H - 60) + 30
  });

  // Background
  ctx.fillStyle = '#1a1f2e';
  ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = '#2e3250';
  ctx.lineWidth = 1;
  const gridStep = Math.pow(10, Math.floor(Math.log10((maxX - minX) / 5)));
  const startX = Math.ceil(minX / gridStep) * gridStep;
  for (let gx = startX; gx < maxX; gx += gridStep) {
    const { cx } = toCanvas(gx, minZ);
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
    ctx.fillStyle = '#3a4060'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText(gx.toFixed(0), cx, H-4);
  }
  const startZ = Math.ceil(minZ / gridStep) * gridStep;
  for (let gz = startZ; gz < maxZ; gz += gridStep) {
    const { cy } = toCanvas(minX, gz);
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();
    ctx.fillStyle = '#3a4060'; ctx.font = '10px monospace'; ctx.textAlign = 'left';
    ctx.fillText(gz.toFixed(0), 2, cy - 2);
  }

  // Draw agents
  positions.forEach(({ name, x, z }) => {
    const { cx, cy } = toCanvas(x, z);
    const color = AGENT_COLORS[name];

    // Glow
    const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, 20);
    grd.addColorStop(0, color + '66');
    grd.addColorStop(1, 'transparent');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(cx, cy, 20, 0, Math.PI*2); ctx.fill();

    // Dot
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI*2); ctx.fill();

    // Label
    ctx.fillStyle = '#e8eaf6';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(name, cx, cy - 12);

    // Coords
    ctx.fillStyle = '#7b82a8';
    ctx.font = '9px monospace';
    ctx.fillText(`${x.toFixed(0)},${z.toFixed(0)}`, cx, cy + 18);
  });

  // Legend
  const legend = document.getElementById('map-legend');
  legend.innerHTML = positions.map(p => `
    <div class="map-legend-item">
      <div class="legend-dot" style="background:${AGENT_COLORS[p.name]}"></div>
      ${p.name} (${p.x.toFixed(0)}, ${agentStates[p.name]?.gameplay?.position?.y?.toFixed(0)}, ${p.z.toFixed(0)})
    </div>
  `).join('');
}

// ===== METRICS =====
function updateTotalStats() {
  const el = document.getElementById('total-stats');
  const totalCalls = Object.values(metrics.totalCalls || {}).reduce((a,b)=>a+b,0);
  const allTimes = AGENTS.flatMap(n => (metrics.responseTimes?.[n] || []).map(r => r.ms));
  const avgMs = allTimes.length ? Math.round(allTimes.reduce((a,b)=>a+b,0)/allTimes.length) : 0;
  const totalCmds = AGENTS.reduce((sum, n) => sum + Object.values(metrics.commandCounts?.[n]||{}).reduce((a,b)=>a+b,0), 0);
  const activeAgents = AGENTS.filter(n => agentStates[n]).length;

  el.innerHTML = [
    { val: totalCalls, lbl: 'LLM Calls' },
    { val: avgMs + 'ms', lbl: 'Avg Response' },
    { val: totalCmds, lbl: 'Commands Run' },
    { val: activeAgents + '/5', lbl: 'Agents Online' },
    { val: Object.keys(metrics.commandCounts?.[AGENTS[0]]||{}).length + ' types', lbl: 'Command Types' },
  ].map(s => `<div class="stat-box"><div class="val">${s.val}</div><div class="lbl">${s.lbl}</div></div>`).join('');
}

function updateCharts() {
  // Response time chart
  const allTimes = [];
  AGENTS.forEach(n => {
    (metrics.responseTimes?.[n] || []).forEach(r => allTimes.push({ agent: n, ms: r.ms, ts: r.ts }));
  });
  allTimes.sort((a,b) => a.ts - b.ts);
  const last30 = allTimes.slice(-30);

  if (!charts.responseTime) {
    charts.responseTime = new Chart(document.getElementById('chart-response-time').getContext('2d'), {
      type: 'line',
      data: { labels: [], datasets: AGENTS.map(n => ({ label: n, data: [], borderColor: AGENT_COLORS[n], backgroundColor: AGENT_COLORS[n]+'33', tension: 0.3, pointRadius: 3 })) },
      options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { labels: { color: '#e8eaf6', boxWidth: 12 } } }, scales: { x: { ticks: { color: '#7b82a8', maxTicksLimit: 8 } }, y: { ticks: { color: '#7b82a8' }, title: { display: true, text: 'ms', color: '#7b82a8' } } } }
    });
  }
  // Rebuild response time data per agent
  AGENTS.forEach((n, i) => {
    const agentTimes = (metrics.responseTimes?.[n] || []).slice(-10);
    charts.responseTime.data.datasets[i].data = agentTimes.map(r => r.ms);
  });
  const maxLen = Math.max(...AGENTS.map(n => (metrics.responseTimes?.[n]||[]).length));
  charts.responseTime.data.labels = Array.from({length: Math.min(maxLen, 10)}, (_,i)=>i+1);
  charts.responseTime.update('none');

  // Commands per agent bar
  const cmdTotals = AGENTS.map(n => Object.values(metrics.commandCounts?.[n]||{}).reduce((a,b)=>a+b,0));
  if (!charts.commands) {
    charts.commands = new Chart(document.getElementById('chart-commands').getContext('2d'), {
      type: 'bar',
      data: { labels: AGENTS, datasets: [{ label: 'Commands', data: cmdTotals, backgroundColor: AGENTS.map(n=>AGENT_COLORS[n]) }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#e8eaf6' } }, y: { ticks: { color: '#7b82a8' } } } }
    });
  } else {
    charts.commands.data.datasets[0].data = cmdTotals;
    charts.commands.update('none');
  }

  // Total API calls
  const callTotals = AGENTS.map(n => metrics.totalCalls?.[n] || 0);
  if (!charts.calls) {
    charts.calls = new Chart(document.getElementById('chart-calls').getContext('2d'), {
      type: 'bar',
      data: { labels: AGENTS, datasets: [{ label: 'LLM Calls', data: callTotals, backgroundColor: AGENTS.map(n=>AGENT_COLORS[n]+'aa') }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#e8eaf6' } }, y: { ticks: { color: '#7b82a8' } } } }
    });
  } else {
    charts.calls.data.datasets[0].data = callTotals;
    charts.calls.update('none');
  }

  // Command type distribution (all agents combined)
  const cmdTypeCombined = {};
  AGENTS.forEach(n => { Object.entries(metrics.commandCounts?.[n]||{}).forEach(([k,v]) => { cmdTypeCombined[k] = (cmdTypeCombined[k]||0)+v; }); });
  const cmdTypes = Object.entries(cmdTypeCombined).sort((a,b)=>b[1]-a[1]).slice(0,10);
  if (!charts.cmdTypes) {
    charts.cmdTypes = new Chart(document.getElementById('chart-cmd-types').getContext('2d'), {
      type: 'doughnut',
      data: { labels: cmdTypes.map(([k])=>k), datasets: [{ data: cmdTypes.map(([,v])=>v), backgroundColor: ['#5b6af5','#00c8a0','#f5a623','#e84040','#ce93d8','#64b5f6','#81c784','#ff8a65','#e57373','#ffb74d'] }] },
      options: { responsive: true, plugins: { legend: { labels: { color: '#e8eaf6', boxWidth: 12, font: { size: 11 } } } } }
    });
  } else {
    charts.cmdTypes.data.labels = cmdTypes.map(([k])=>k);
    charts.cmdTypes.data.datasets[0].data = cmdTypes.map(([,v])=>v);
    charts.cmdTypes.update('none');
  }
}

function handleMetricUpdate(data) {
  if (!metrics.responseTimes) return;
  if (data.type === 'response-time') {
    if (!metrics.responseTimes[data.agent]) metrics.responseTimes[data.agent] = [];
    metrics.responseTimes[data.agent].push({ ts: Date.now(), ms: data.ms });
    if (metrics.responseTimes[data.agent].length > 50) metrics.responseTimes[data.agent].shift();
    if (!metrics.totalCalls[data.agent]) metrics.totalCalls[data.agent] = 0;
    metrics.totalCalls[data.agent]++;
  }
}

// ===== MEMORIES =====
function switchMemTab(el, agent) {
  document.querySelectorAll('.memory-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  activeMemTab = agent;
  if (agent === '_chroma') renderChromaPanel();
  else loadMemory(agent);
}

async function loadMemory(agent) {
  activeMemTab = agent;
  const container = document.getElementById('mem-panels');
  try {
    const r = await fetch(`/api/memories/${agent}`);
    const data = await r.json();
    const summary = data.memory || '(no summary yet)';
    const turns = data.turns || [];
    const goal = data.self_prompt ? `<div style="background:#1a2535;border-radius:6px;padding:10px;margin-bottom:12px;font-size:12px;color:var(--accent2)">🎯 Current Goal: ${data.self_prompt}</div>` : '';

    container.innerHTML = `
      ${goal}
      <div style="margin-bottom:8px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Memory Summary</div>
      <div class="memory-summary">${summary || '<em style="color:var(--muted)">Memory bank empty</em>'}</div>
      <div style="margin-bottom:8px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Conversation Turns (${turns.length})</div>
      <div class="memory-turns">
        ${turns.map(t => `
          <div class="turn ${t.role}">
            <div class="turn-role">${t.role}</div>
            <div>${escHtml(t.content.slice(0, 800))}${t.content.length > 800 ? '...' : ''}</div>
          </div>
        `).join('')}
      </div>
    `;
  } catch(e) {
    container.innerHTML = `<div style="color:var(--danger)">Failed to load memory: ${e.message}</div>`;
  }
}

function renderChromaPanel() {
  const container = document.getElementById('mem-panels');
  container.innerHTML = `
    <div class="chroma-search">
      <input type="text" id="chroma-query" placeholder="Search agent memories..." />
      <select id="chroma-coll">
        ${AGENTS.map(n=>`<option value="${n.toLowerCase()}_memory">${n}</option>`).join('')}
        <option value="">All agents</option>
      </select>
      <button class="btn btn-primary" onclick="searchChroma()">Search</button>
    </div>
    <div class="chroma-results" id="chroma-results">
      <div style="color:var(--muted);font-size:13px">Enter a search query above to search agent vector memories.</div>
    </div>
  `;
}

async function searchChroma() {
  const query = document.getElementById('chroma-query').value;
  const coll = document.getElementById('chroma-coll').value;
  const container = document.getElementById('chroma-results');
  if (!query) return;
  container.innerHTML = '<div style="color:var(--muted)">Searching...</div>';

  const collections = coll ? [coll] : AGENTS.map(n => n.toLowerCase() + '_memory');
  const allResults = [];

  for (const c of collections) {
    try {
      const r = await fetch('/api/chromadb/search', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ collection: c, query, n: 5 })
      });
      const d = await r.json();
      if (d.documents?.[0]) {
        d.documents[0].forEach((doc, i) => {
          allResults.push({ collection: c, doc, dist: d.distances?.[0]?.[i]?.toFixed(3) });
        });
      }
    } catch {}
  }

  if (!allResults.length) { container.innerHTML = '<div style="color:var(--muted)">No results found.</div>'; return; }

  container.innerHTML = allResults.map(r => `
    <div class="chroma-result">
      <span class="dist">dist: ${r.dist}</span>
      <strong style="font-size:11px;color:var(--muted)">${r.collection}</strong>
      <div style="margin-top:4px">${escHtml(r.doc)}</div>
    </div>
  `).join('');
}

// ===== LOGS =====
function switchLogTab(el, tab) {
  document.querySelectorAll('.log-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  activeLogTab = tab;
  renderLogBox();
}

function appendLogLine(source, line) {
  if (!logLines[source]) logLines[source] = [];
  logLines[source].push(line);
  if (logLines[source].length > 500) logLines[source].shift();
  if (source === activeLogTab) {
    const filter = document.getElementById('log-filter').value.toLowerCase();
    if (!filter || line.toLowerCase().includes(filter)) {
      addLineToBox(line);
    }
  }
}

function addLineToBox(line) {
  const box = document.getElementById('log-box');
  const el = document.createElement('div');
  el.className = 'log-line ' + classifyLine(line);
  el.textContent = line;
  box.appendChild(el);
  if (autoScroll) box.scrollTop = box.scrollHeight;
  // Keep max 300 DOM elements
  while (box.children.length > 300) box.removeChild(box.firstChild);
}

function renderLogBox() {
  const box = document.getElementById('log-box');
  box.innerHTML = '';
  const filter = document.getElementById('log-filter').value.toLowerCase();
  const lines = logLines[activeLogTab] || [];
  lines.filter(l => !filter || l.toLowerCase().includes(filter))
       .slice(-200).forEach(l => addLineToBox(l));
}

function classifyLine(line) {
  if (line.includes('[ERROR]') || line.includes('ERROR')) return 'error';
  if (line.includes('WARN') || line.includes('warn')) return 'warn';
  if (line.includes('Generated response') || line.includes('full response')) return 'response';
  if (line.includes('parsed command') || line.includes('executing code')) return 'command';
  if (line.includes('Done!') || line.includes('success') || line.includes('Saved memory')) return 'success';
  return 'info';
}

function applyLogFilter() { renderLogBox(); }

function toggleAutoScroll() {
  autoScroll = !autoScroll;
  document.getElementById('scroll-label').textContent = autoScroll ? 'ON' : 'OFF';
}

function clearLogs() {
  logLines[activeLogTab] = [];
  document.getElementById('log-box').innerHTML = '';
}

// ===== CONTROLS =====
async function stackControl(action) {
  const out = document.getElementById('control-output');
  out.textContent = `Running ${action}...`;
  try {
    const r = await fetch(`/api/control/${action}`, { method: 'POST' });
    const d = await r.json();
    out.textContent = d.ok ? `✓ ${action} OK\n${d.stdout || ''}` : `✗ ${d.error}`;
  } catch(e) { out.textContent = '✗ ' + e.message; }
}

async function sendRcon() {
  const input = document.getElementById('rcon-input');
  const out = document.getElementById('rcon-output');
  const cmd = input.value.trim();
  if (!cmd) return;
  out.textContent = 'Sending...';
  try {
    const r = await fetch('/api/rcon', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({command: cmd}) });
    const d = await r.json();
    out.textContent = d.result || d.error;
    input.value = '';
  } catch(e) { out.textContent = '✗ ' + e.message; }
}

document.getElementById('rcon-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendRcon();
});

async function agentAction(name, action) {
  try {
    await fetch(`/api/agents/${name}/${action}`, { method: 'POST' });
  } catch(e) { console.error(e); }
}

// ===== UTILS =====
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ===== SIDEBAR ACTIVE STATE =====
const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const id = entry.target.id;
      document.querySelectorAll('#sidebar nav a').forEach(a => {
        a.classList.toggle('active', a.getAttribute('href') === '#' + id);
      });
    }
  });
}, { threshold: 0.3 });

document.querySelectorAll('section[id]').forEach(s => observer.observe(s));

// ===== MAP RESIZE =====
window.addEventListener('resize', () => renderWorldMap());

// ===== BOOT =====
renderAgentCards();
renderAgentQuickControls();
renderChromaPanel();
updateTotalStats();

// Load first memory tab
loadMemory('Rook');

// Periodic world map refresh
setInterval(() => renderWorldMap(), 2000);
</script>
</body>
</html>
```

**Step 2: Verify it loads at http://localhost:4000**

Start the server (with all previous tasks' code in place):
```bash
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/dashboard && node server.js &
sleep 3
curl -s -o /dev/null -w "%{http_code}" http://localhost:4000
```
Expected: `200`

Open http://localhost:4000 in a browser. Should see full dark dashboard with sidebar, all 7 sections.

**Step 3: Verify live data flows**

- Agent cards should populate (within 5s of MindServer connecting)
- World map should show agent markers
- Logs should start streaming
- RCON field: type `list` and hit Enter — should return player list

**Step 4: Kill and commit**

```bash
kill %1
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux
git add dashboard/
git commit -m "feat: full simulation dashboard frontend — all 7 sections"
```

---

## Task 6: Run as Persistent Service on Mac Mini

Make the dashboard auto-start and survive reboots.

**Files:**
- Create: `dashboard/start-dashboard.sh`

**Step 1: Create launcher script**

`dashboard/start-dashboard.sh`:
```bash
#!/bin/bash
cd "$(dirname "$0")"
exec node server.js
```

```bash
chmod +x /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/dashboard/start-dashboard.sh
```

**Step 2: Create launchd plist for auto-start**

File: `~/Library/LaunchAgents/com.minecraft-ai.dashboard.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.minecraft-ai.dashboard</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/dashboard/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/dashboard</string>
  <key>StandardOutPath</key>
  <string>/tmp/minecraft-dashboard.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/minecraft-dashboard.err</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
```

**Step 3: Load the service**

```bash
launchctl load ~/Library/LaunchAgents/com.minecraft-ai.dashboard.plist
sleep 2
curl -s http://localhost:4000/api/health
```

Expected: `{"ok":true,...}`

**Step 4: Verify Tailscale access**

```bash
curl -s http://100.85.249.61:4000/api/health
```

Expected: same response (if Tailscale is active)

**Step 5: Commit**

```bash
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux
git add dashboard/
git commit -m "feat: launchd service for persistent dashboard on Mac Mini"
```

---

## Quick Verification After All Tasks

```bash
# Dashboard up
curl -s http://localhost:4000/api/health

# Agent states flowing
curl -s http://localhost:4000/api/agents | python3 -m json.tool | head -20

# Memory readable
curl -s http://localhost:4000/api/memories/Sage | python3 -m json.tool | head -10

# ChromaDB accessible
curl -s http://localhost:4000/api/chromadb/collections | python3 -m json.tool

# RCON working
curl -s -X POST http://localhost:4000/api/rcon \
  -H 'Content-Type: application/json' \
  -d '{"command":"list"}'

# Tailscale
curl -s http://100.85.249.61:4000/api/health
```

All should return valid JSON.

---

## Dashboard Access

| From | URL |
|------|-----|
| Mac Mini (local) | http://localhost:4000 |
| Local network (any device) | http://10.0.0.223:4000 |
| Tailscale (iPad, work) | http://100.85.249.61:4000 |
