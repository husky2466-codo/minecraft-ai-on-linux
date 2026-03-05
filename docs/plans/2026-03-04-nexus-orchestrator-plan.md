# Nexus External Orchestrator — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the in-world Nexus bot with a standalone `pipeline/nexus-orchestrator.js` that uses a mineflayer eye-bot + qwen2.5vl:7b vision + qwen3.5:27b reasoning to autonomously direct the 5 agents every 60 seconds.

**Architecture:** A Node.js process runs on the Linux Desktop (10.0.0.10). It spawns a mineflayer "NexusEye" bot that holds a fixed elevated position in-world while prismarine-viewer renders its view. Puppeteer screenshots that view, sends it to qwen2.5vl:7b for a world description, then qwen3.5:27b receives description + agent states + recent logs and returns per-agent directives which are sent via MindServer socket.

**Tech Stack:** Node.js (CJS), mineflayer, prismarine-viewer, puppeteer, socket.io-client, Ollama HTTP API (DGX at 10.0.0.69:11434)

**Working directory for all SSH commands:** Linux Desktop at `10.0.0.10` via `ssh myroproductions@10.0.0.10`
**Code is written locally on Mac Mini then pushed; Linux pulls and runs.**

---

### Task 1: Pull qwen2.5vl:7b on DGX

**Files:** none

**Step 1: Pull the vision model via Ollama API**

```bash
curl -s -X POST http://10.0.0.69:11434/api/pull \
  -H 'Content-Type: application/json' \
  -d '{"name":"qwen2.5vl:7b","stream":false}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))"
```

Expected: `success` (takes 5–15 minutes if not cached)

**Step 2: Verify model is listed**

```bash
curl -s http://10.0.0.69:11434/api/tags | python3 -c "import sys,json; [print(m['name']) for m in json.load(sys.stdin).get('models',[])]"
```

Expected: `qwen2.5vl:7b` appears in list alongside `qwen3.5:27b`

**Step 3: Smoke-test vision model with a tiny text prompt**

```bash
curl -s -X POST http://10.0.0.69:11434/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen2.5vl:7b","prompt":"Say hello in one word.","stream":false}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['response'])"
```

Expected: short greeting response (proves model loads and responds)

---

### Task 2: Create pipeline/package.json and install dependencies

**Files:**
- Create: `pipeline/package.json`

**Step 1: Write pipeline/package.json**

```json
{
  "name": "nexus-pipeline",
  "version": "1.0.0",
  "description": "Nexus orchestrator and supporting pipeline processes",
  "type": "commonjs",
  "dependencies": {
    "mineflayer": "^4.23.0",
    "prismarine-viewer": "^1.28.0",
    "puppeteer": "^22.0.0",
    "socket.io-client": "^4.7.5"
  }
}
```

**Step 2: Install dependencies on the Linux Desktop**

```bash
ssh myroproductions@10.0.0.10 "cd ~/Projects/minecraft-ai-on-linux/pipeline && npm install"
```

Expected: `added N packages` with no errors. puppeteer will download Chromium (~170MB) — this is expected.

**Step 3: Verify key packages exist**

```bash
ssh myroproductions@10.0.0.10 "ls ~/Projects/minecraft-ai-on-linux/pipeline/node_modules | grep -E 'mineflayer|prismarine-viewer|puppeteer|socket.io-client'"
```

Expected: all four appear.

**Step 4: Commit package.json (node_modules is gitignored)**

```bash
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux
# Verify pipeline is in .gitignore node_modules
grep -r "node_modules" .gitignore pipeline/.gitignore 2>/dev/null || echo "no pipeline gitignore"
```

If no `pipeline/.gitignore`:
```bash
echo "node_modules/" > pipeline/.gitignore
```

```bash
git add pipeline/package.json pipeline/.gitignore
git commit -m "feat(nexus): add pipeline package.json with orchestrator dependencies"
```

---

### Task 3: Remove Nexus from MindCraft settings

**Files:**
- Modify: `mindcraft/settings.js`

**Step 1: Remove nexus.json from profiles array**

Edit `mindcraft/settings.js`. Find:
```js
"profiles": [
    "./profiles/agents/nexus.json",   // orchestrator — DGX qwen2.5:7b
    "./profiles/agents/rook.json",
```

Change to:
```js
"profiles": [
    "./profiles/agents/rook.json",
```

**Step 2: Verify nexus is gone**

```bash
grep -n "nexus" /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/mindcraft/settings.js
```

Expected: no output (nexus.json no longer referenced in profiles).

**Step 3: Commit**

```bash
git add mindcraft/settings.js
git commit -m "feat(nexus): remove Nexus bot from MindCraft — now external orchestrator"
```

---

### Task 4: Update dashboard/server.js — remove nexus_memory, update stack commands

**Files:**
- Modify: `dashboard/server.js`

**Step 1: Remove nexus_memory from CHROMA_COLLECTIONS**

Find in `dashboard/server.js`:
```js
const CHROMA_COLLECTIONS = ['rook_memory', 'vex_memory', 'sage_memory', 'echo_memory', 'drift_memory', 'nexus_memory'];
```

Change to:
```js
const CHROMA_COLLECTIONS = ['rook_memory', 'vex_memory', 'sage_memory', 'echo_memory', 'drift_memory'];
```

**Step 2: Add nexus-orchestrator to START_INNER**

Find the `START_INNER` array in `dashboard/server.js`. After the MindCraft start line:
```js
`${PATH_PREFIX} nohup ${NODE} main.js > ~/mindcraft.log 2>&1 &`,
'echo "Stack started at $(date)"',
```

Change to:
```js
`${PATH_PREFIX} nohup ${NODE} main.js > ~/mindcraft.log 2>&1 &`,
'sleep 15',
`cd ${PROJECT}/pipeline`,
`nohup ${NODE} nexus-orchestrator.js > ~/nexus-orchestrator.log 2>&1 &`,
'echo "Stack started at $(date)"',
```

**Step 3: Add nexus-orchestrator kill to STOP_CMD**

In the `STOP_CMD` array, after the MindCraft kill lines, add:
```js
// Nexus orchestrator (identified by nexus-orchestrator.js in argv — safe, no self-match risk)
'NXPID=$(pgrep -f "nexus-orchestrator.js" | head -1)',
'[ -n "$NXPID" ] && kill -9 $NXPID 2>/dev/null',
```

Note: `pgrep -f nexus-orchestrator.js` is safe here because the dashboard server process itself does NOT contain that string in its argv — only the target process does.

**Step 4: Commit**

```bash
git add dashboard/server.js
git commit -m "feat(nexus): update stack commands to start/stop nexus-orchestrator"
```

---

### Task 5: Write nexus-orchestrator.js — eye-bot + prismarine-viewer

**Files:**
- Create: `pipeline/nexus-orchestrator.js`

**Step 1: Write the eye-bot and viewer scaffold**

Create `pipeline/nexus-orchestrator.js`:

```js
'use strict';
const mineflayer = require('mineflayer');
const { mineflayer: mineflayerViewer } = require('prismarine-viewer');
const puppeteer = require('puppeteer');
const { io } = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────
const MC_HOST         = '127.0.0.1';
const MC_PORT         = 25565;
const VIEWER_PORT     = 3099;
const MINDSERVER_URL  = 'http://127.0.0.1:8080';
const OLLAMA_BASE     = 'http://10.0.0.69:11434';
const VISION_MODEL    = 'qwen2.5vl:7b';
const REASON_MODEL    = 'qwen3.5:27b';
const INTERVAL_MS     = parseInt(process.env.NEXUS_INTERVAL_MS || '60000', 10);
const MC_LOG          = path.join(process.env.HOME, 'mindcraft.log');
const OUT_LOG         = path.join(process.env.HOME, 'nexus-orchestrator.log');

const AGENT_ROLES = {
  Rook:  'gatherer — mines resources and fills storage chests',
  Vex:   'combat — guards the base and eliminates threats',
  Drift: 'explorer — maps new terrain and finds biomes/resources',
  Echo:  'coordinator — tracks agent relationships and shares resources',
  Sage:  'engineer — crafts tools, builds structures, manages inventory',
};

// ── State ─────────────────────────────────────────────────────────────────
let eyeBot        = null;
let browser       = null;
let page          = null;
let agentStates   = {};
let agentList     = [];
let lastFrame     = null;   // latest PNG Buffer from screenshot
let loopRunning   = false;

// ── Logging ───────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(OUT_LOG, line + '\n');
}

// ── Eye-bot ───────────────────────────────────────────────────────────────
function startEyeBot() {
  eyeBot = mineflayer.createBot({
    host: MC_HOST,
    port: MC_PORT,
    username: 'NexusEye',
    version: '1.21.1',
    auth: 'offline',
  });

  eyeBot.once('spawn', () => {
    log('[EyeBot] NexusEye spawned in world');
    mineflayerViewer(eyeBot, { port: VIEWER_PORT, firstPerson: false });
    log(`[EyeBot] prismarine-viewer on :${VIEWER_PORT}`);
  });

  eyeBot.on('error', (err) => log(`[EyeBot] Error: ${err.message}`));

  eyeBot.on('end', (reason) => {
    log(`[EyeBot] Disconnected (${reason}) — reconnecting in 10s`);
    eyeBot = null;
    setTimeout(startEyeBot, 10_000);
  });
}

// ── Puppeteer setup ───────────────────────────────────────────────────────
async function startBrowser() {
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-gl=swiftshader',
      '--disable-dev-shm-usage',
      '--disable-web-security',
    ],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 854, height: 480 });
  // Wait for viewer to be ready then load it
  await new Promise(r => setTimeout(r, 8000));
  await page.goto(`http://127.0.0.1:${VIEWER_PORT}`, { waitUntil: 'networkidle0', timeout: 30000 });
  log('[Puppeteer] Viewer page loaded');
}

// ── Screenshot ────────────────────────────────────────────────────────────
async function captureFrame() {
  if (!page) return null;
  try {
    const buf = await page.screenshot({ type: 'png', encoding: 'binary' });
    return Buffer.from(buf);
  } catch (e) {
    log(`[Screenshot] Failed: ${e.message}`);
    return null;
  }
}

module.exports = { log, startEyeBot, startBrowser, captureFrame };

// ── Entry point (if run directly) ────────────────────────────────────────
if (require.main === module) {
  (async () => {
    log('=== Nexus Orchestrator starting ===');
    startEyeBot();
    // Give bot time to spawn before starting browser
    setTimeout(async () => {
      await startBrowser();
      log('[Init] Ready — waiting for first loop tick');
    }, 12_000);
  })();
}
```

**Step 2: Push and test eye-bot connects to MC**

```bash
git add pipeline/nexus-orchestrator.js
git commit -m "feat(nexus): eye-bot + prismarine-viewer scaffold"
git push origin main
ssh myroproductions@10.0.0.10 "cd ~/Projects/minecraft-ai-on-linux && git pull && cd pipeline && node nexus-orchestrator.js &"
sleep 20
ssh myroproductions@10.0.0.10 "grep -E 'NexusEye|EyeBot|Puppeteer' ~/nexus-orchestrator.log | tail -10"
```

Expected output:
```
[...] [EyeBot] NexusEye spawned in world
[...] [EyeBot] prismarine-viewer on :3099
[...] [Puppeteer] Viewer page loaded
```

Also check Minecraft server log:
```bash
ssh myroproductions@10.0.0.10 "grep NexusEye ~/minecraft-server/server.log | tail -3"
```

Expected: `NexusEye joined the game`

**Step 3: Kill test process**

```bash
ssh myroproductions@10.0.0.10 "pkill -f nexus-orchestrator.js"
```

---

### Task 6: Add vision model call

**Files:**
- Modify: `pipeline/nexus-orchestrator.js`

**Step 1: Add ollama helper and vision function**

Add these functions to `pipeline/nexus-orchestrator.js`, before the `module.exports` line:

```js
// ── Ollama HTTP helper ────────────────────────────────────────────────────
function ollamaPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '10.0.0.69',
      port: 11434,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON parse failed: ${raw.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Vision — qwen2.5vl:7b ─────────────────────────────────────────────────
async function describeFrame(pngBuffer) {
  if (!pngBuffer) return 'No visual data available.';
  const b64 = pngBuffer.toString('base64');
  try {
    const res = await ollamaPost('/api/generate', {
      model: VISION_MODEL,
      prompt: 'This is a screenshot from a Minecraft world. Describe in 2-3 sentences: what terrain is visible, what structures have been built, and whether any player-like figures (agents) appear to be active or idle.',
      images: [b64],
      stream: false,
    });
    return res.response?.trim() || 'Vision model returned empty response.';
  } catch (e) {
    log(`[Vision] Error: ${e.message}`);
    return 'Vision unavailable this cycle.';
  }
}
```

**Step 2: Commit**

```bash
git add pipeline/nexus-orchestrator.js
git commit -m "feat(nexus): add vision model call — qwen2.5vl:7b"
```

**Step 3: Quick smoke test of vision API directly**

```bash
curl -s -X POST http://10.0.0.69:11434/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen2.5vl:7b","prompt":"What color is the sky?","images":[],"stream":false}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('response','ERROR')[:200])"
```

Expected: some response text (even without a real image, model should respond)

---

### Task 7: Add MindServer socket connection + log tail

**Files:**
- Modify: `pipeline/nexus-orchestrator.js`

**Step 1: Add MindServer socket client**

Add after the Ollama helper, before `module.exports`:

```js
// ── MindServer socket ─────────────────────────────────────────────────────
function connectMindServer() {
  const socket = io(MINDSERVER_URL, { reconnection: true, reconnectionDelay: 5000 });

  socket.on('connect', () => {
    log('[MindServer] Connected');
    socket.emit('listen-to-agents');
  });

  socket.on('disconnect', () => log('[MindServer] Disconnected — will reconnect'));

  socket.on('agents-status', (agents) => {
    agentList = agents;
    log(`[MindServer] Agent list: ${agents.map(a => a.name).join(', ')}`);
  });

  socket.on('state-update', (states) => {
    const arr = Array.isArray(states) ? states : Object.values(states);
    arr.forEach(s => { if (s?.name) agentStates[s.name] = s; });
  });

  socket.on('connect_error', (e) => log(`[MindServer] Connect error: ${e.message}`));

  return socket;
}

// ── Log tail ──────────────────────────────────────────────────────────────
function readLastLines(filePath, n = 50) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch (_) {
    return '';
  }
}
```

**Step 2: Commit**

```bash
git add pipeline/nexus-orchestrator.js
git commit -m "feat(nexus): MindServer socket client + log tail utility"
```

---

### Task 8: Add reasoning loop — qwen3.5:27b + directive parser

**Files:**
- Modify: `pipeline/nexus-orchestrator.js`

**Step 1: Add context builder and reasoning call**

Add after the log tail function, before `module.exports`:

```js
// ── Reasoning — qwen3.5:27b ───────────────────────────────────────────────
function buildAgentContext() {
  const known = Object.keys(AGENT_ROLES);
  return known.map(name => {
    const s = agentStates[name];
    if (!s) return `${name} (${AGENT_ROLES[name]}): no data yet`;
    const pos = s.position ? `pos=(${Math.round(s.position.x)},${Math.round(s.position.y)},${Math.round(s.position.z)})` : 'pos=unknown';
    const task = s.task || s.current_action || 'idle';
    const inv = s.inventory
      ? Object.entries(s.inventory).slice(0, 5).map(([k, v]) => `${k}×${v}`).join(', ') || 'empty'
      : 'unknown';
    return `${name} (${AGENT_ROLES[name]}): ${pos}, task="${task}", inventory=[${inv}]`;
  }).join('\n');
}

async function getDirectives(visualDescription, recentLogs) {
  const agentCtx = buildAgentContext();
  const systemPrompt = `You are Nexus — the autonomous orchestrator for a 5-agent Minecraft AI team.
Your only output is directives. One directive per agent that needs redirecting.
Agents that are actively working on the right task need NO directive — leave them alone.
Prioritize: (1) active threats, (2) empty storage, (3) missing materials, (4) exploration, (5) building.
Keep each directive under 20 words. Be specific. Use imperative commands.

Format your response EXACTLY as:
AgentName: directive text
AgentName: directive text
(only list agents that need a directive — omit agents doing fine)`;

  const userPrompt = `VISUAL SNAPSHOT:
${visualDescription}

AGENT STATES:
${agentCtx}

RECENT ACTIVITY (last 50 log lines):
${recentLogs.slice(-2000)}

Issue directives now.`;

  try {
    const res = await ollamaPost('/api/chat', {
      model: REASON_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      options: { num_predict: 300 },
    });
    return res.message?.content?.trim() || '';
  } catch (e) {
    log(`[Reason] Error: ${e.message}`);
    return '';
  }
}

// ── Directive parser + sender ──────────────────────────────────────────────
function parseDirectives(raw) {
  const known = new Set(Object.keys(AGENT_ROLES));
  const directives = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z]+):\s*(.+)$/);
    if (m && known.has(m[1])) {
      directives.push({ agent: m[1], message: m[2].trim() });
    }
  }
  return directives;
}

function sendDirective(socket, agent, message) {
  if (!socket?.connected) {
    log(`[Send] MindServer not connected — skipping directive for ${agent}`);
    return;
  }
  socket.emit('send-message', agent, { from: 'Nexus', message });
  log(`[Directive] → ${agent}: ${message}`);
}
```

**Step 2: Commit**

```bash
git add pipeline/nexus-orchestrator.js
git commit -m "feat(nexus): reasoning loop — qwen3.5:27b prompt + directive parser/sender"
```

---

### Task 9: Wire the main loop and finalize entry point

**Files:**
- Modify: `pipeline/nexus-orchestrator.js`

**Step 1: Replace the entry point block with the full wired loop**

Find and replace the `if (require.main === module)` block at the bottom of the file:

```js
if (require.main === module) {
  (async () => {
    log('=== Nexus Orchestrator starting ===');
    log(`Loop interval: ${INTERVAL_MS}ms | Vision: ${VISION_MODEL} | Reason: ${REASON_MODEL}`);

    // Start eye-bot
    startEyeBot();

    // Start MindServer connection
    const msSocket = connectMindServer();

    // Give bot time to spawn, then start browser
    await new Promise(r => setTimeout(r, 12_000));
    await startBrowser();
    log('[Init] All systems ready — starting orchestration loop');

    // Main loop
    async function runLoop() {
      if (loopRunning) return;
      loopRunning = true;
      log('--- Loop tick ---');
      try {
        // 1. Capture
        const frame = await captureFrame();
        if (frame) lastFrame = frame;

        // 2. See
        const visual = await describeFrame(lastFrame);
        log(`[Vision] ${visual}`);

        // 3. Read logs
        const recentLogs = readLastLines(MC_LOG, 50);

        // 4. Think
        const raw = await getDirectives(visual, recentLogs);
        log(`[Reason] Raw response:\n${raw}`);

        // 5. Act
        const directives = parseDirectives(raw);
        if (directives.length === 0) {
          log('[Act] No directives issued this cycle — agents on track');
        } else {
          for (const { agent, message } of directives) {
            sendDirective(msSocket, agent, message);
          }
        }
      } catch (e) {
        log(`[Loop] Unhandled error: ${e.message}`);
      } finally {
        loopRunning = false;
      }
    }

    // First tick after a short delay, then every INTERVAL_MS
    setTimeout(runLoop, 5_000);
    setInterval(runLoop, INTERVAL_MS);
  })();
}
```

**Step 2: Commit**

```bash
git add pipeline/nexus-orchestrator.js
git commit -m "feat(nexus): wire full orchestration loop — capture→see→read→think→act"
git push origin main
```

---

### Task 10: Integration test — full run

**Files:** none (testing only)

**Step 1: Pull latest on Linux Desktop**

```bash
ssh myroproductions@10.0.0.10 "cd ~/Projects/minecraft-ai-on-linux && git pull"
```

**Step 2: Make sure Minecraft + MindCraft are running (without nexus bot)**

```bash
ssh myroproductions@10.0.0.10 "tail -5 ~/minecraft-server/server.log"
```

Expected: agents (Rook, Vex, etc.) logged in, NexusEye absent.

If stack is down, start via dashboard `/api/control/start`.

**Step 3: Run nexus-orchestrator manually**

```bash
ssh myroproductions@10.0.0.10 "cd ~/Projects/minecraft-ai-on-linux/pipeline && node nexus-orchestrator.js >> ~/nexus-orchestrator.log 2>&1 &"
```

**Step 4: Watch the log for 90 seconds**

```bash
ssh myroproductions@10.0.0.10 "tail -f ~/nexus-orchestrator.log"
# Ctrl+C after ~90s
```

Expected sequence:
```
[...] === Nexus Orchestrator starting ===
[...] [EyeBot] NexusEye spawned in world
[...] [EyeBot] prismarine-viewer on :3099
[...] [MindServer] Connected
[...] [MindServer] Agent list: Rook, Vex, Drift, Echo, Sage
[...] [Puppeteer] Viewer page loaded
[...] [Init] All systems ready — starting orchestration loop
[...] --- Loop tick ---
[...] [Vision] <2-3 sentence world description>
[...] [Reason] Raw response:
       Rook: gather oak_log from nearby forest
       Sage: craft wooden_pickaxe from logs in storage
[...] [Directive] → Rook: gather oak_log from nearby forest
[...] [Directive] → Sage: craft wooden_pickaxe from logs in storage
```

**Step 5: Verify agents received messages**

```bash
ssh myroproductions@10.0.0.10 "grep -E 'Nexus|NexusEye' ~/mindcraft.log | tail -10"
```

Expected: agents responding to Nexus directives in chat.

**Step 6: Kill test process**

```bash
ssh myroproductions@10.0.0.10 "pkill -f nexus-orchestrator.js"
```

---

### Task 11: Update dashboard orchestrator panel to read nexus-orchestrator.log

**Files:**
- Modify: `dashboard/src/log-streamer.js` (check what log file the orchestrator panel reads)
- Modify: `dashboard/server.js`

**Step 1: Check current orchestrator log source in server.js**

```bash
grep -n "orchestrat\|nexus\|log" /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/dashboard/server.js | head -20
```

**Step 2: Add a tail for nexus-orchestrator.log to broadcast to dashboard**

In `dashboard/server.js`, after the existing `tailLog` calls, add:

```js
// Tail nexus orchestrator log — stream to dashboard
tailLog('/home/myroproductions/nexus-orchestrator.log', (line) => {
  broadcast('log-line', { source: 'nexus', line });
});
```

**Step 3: Verify the orchestrator panel in index.html handles 'nexus' source**

```bash
grep -n "nexus\|orchestrat" /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/dashboard/public/index.html | grep -i "source\|log\|nexus" | head -20
```

If the orchestrator terminal filters on a different source name, update accordingly.

**Step 4: Commit**

```bash
git add dashboard/server.js
git commit -m "feat(nexus): stream nexus-orchestrator.log to dashboard orchestrator panel"
git push origin main
```

---

### Task 12: Full stack restart + smoke test

**Files:** none

**Step 1: Pull latest on Linux Desktop and stop current stack**

```bash
ssh myroproductions@10.0.0.10 "cd ~/Projects/minecraft-ai-on-linux && git pull"
```

Use dashboard `/api/control/stop` to stop the stack.

**Step 2: Start fresh via dashboard `/api/control/start`**

Wait ~60 seconds for full boot.

**Step 3: Verify in server.log — NexusEye in, original Nexus bot absent**

```bash
ssh myroproductions@10.0.0.10 "grep 'joined the game\|left the game' ~/minecraft-server/server.log | tail -10"
```

Expected: `NexusEye joined the game` — no `Nexus joined the game`.

**Step 4: Check nexus-orchestrator.log for first loop tick**

```bash
ssh myroproductions@10.0.0.10 "cat ~/nexus-orchestrator.log | tail -30"
```

Expected: complete loop output including directives.

**Step 5: Check dashboard shows NexusEye + orchestrator panel active**

Open http://localhost:4000 — confirm:
- Orchestrator panel shows Nexus log output
- Agent cards show Rook, Vex, Drift, Echo, Sage (no Nexus card)
- Nexus directives appear in orchestrator directive feed

**Step 6: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(nexus): integration fixes from smoke test"
git push origin main
```

---

## Summary of all new/changed files

| File | Change |
|------|--------|
| `pipeline/package.json` | New — npm dependencies |
| `pipeline/.gitignore` | New — ignore node_modules |
| `pipeline/nexus-orchestrator.js` | New — the orchestrator |
| `mindcraft/settings.js` | Remove nexus.json from profiles |
| `dashboard/server.js` | Remove nexus_memory, add nexus-orchestrator to start/stop/log tail |

## Rollback

If anything breaks, re-add `nexus.json` to `mindcraft/settings.js` profiles and remove nexus-orchestrator from START_INNER. The flat world backup is at `~/minecraft-server/world_flat_backup_20260304`.
