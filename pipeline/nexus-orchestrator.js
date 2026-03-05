'use strict';
const mineflayer = require('mineflayer');
const { mineflayer: mineflayerViewer } = require('prismarine-viewer');
const puppeteer = require('puppeteer');
const { io } = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const {
  checkPhase,
  getBottlenecks,
  assignAgents,
  markVisited,
  getNearestUnexplored, // reserved — used in Phase 8 Cave Exploration directives
} = require('./nexus-phase-engine');

// ── Config ────────────────────────────────────────────────────────────────
const MC_HOST        = '127.0.0.1';
const MC_PORT        = 25565;
const VIEWER_PORT    = 3099;
const MINDSERVER_URL = 'http://127.0.0.1:8080';
const VISION_MODEL   = 'qwen2.5vl:7b';
const REASON_MODEL   = 'qwen2.5:7b';
const INTERVAL_MS    = parseInt(process.env.NEXUS_INTERVAL_MS || '30000', 10);
const MC_LOG         = path.join(process.env.HOME, 'mindcraft.log');

// NexusEye orbits the agent cluster — radius/height in blocks, step in degrees per tick
const ORBIT_RADIUS = 35;
const ORBIT_HEIGHT = 22;
const ORBIT_STEP   = 90; // 4 cardinal positions (N/E/S/W) → full loop every ~2 min at 30s ticks

const AGENT_ROLES = {
  Rook:  'gatherer — mines resources and fills storage chests',
  Vex:   'combat — guards the base and eliminates threats',
  Drift: 'farmer — tends crops, breeds animals, and keeps the team fed',
  Echo:  'crafter — smelts ore, cooks food, crafts tools and keeps the team supplied',
  Sage:  'engineer — crafts tools, builds structures, manages inventory',
};

// Phase name lookup for milestone logging (mirrors nexus-phase-engine PHASES order)
const PHASES_FOR_LOG = [
  'Shelter', 'Basic Tools', 'Food Secured', 'Storage System', 'Iron Gathering',
  'Iron Age', 'Armor and Weapons', 'Surface Secured', 'Cave Exploration', 'Nether Prep',
];

// ── State ─────────────────────────────────────────────────────────────────
let eyeBot      = null;
let browser     = null;
let page        = null;
let agentStates = {};
let agentList   = [];
let lastFrame   = null;
let loopRunning  = false;
let msSocket     = null;
let orbitAngle   = 0; // degrees, advances ORBIT_STEP each tick
let viewerStarted = false;

// ── Logging ───────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── Live config (hot-reloaded each tick) ──────────────────────────────────
const CONFIG_FILE = path.join(process.env.HOME, 'nexus-config.json');
function readLiveConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { return {}; }
}
function writeLiveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch (_) {}
}

// ── Task state (persistent per-agent goals across cycles) ─────────────────
const TASK_STATE_FILE = path.join(process.env.HOME, 'nexus-task-state.json');

function readTaskState() {
  try {
    const raw = JSON.parse(fs.readFileSync(TASK_STATE_FILE, 'utf8'));
    return {
      phase:          raw.phase          ?? 0,
      phaseStartedAt: raw.phaseStartedAt ?? new Date().toISOString(),
      goals:          raw.goals          ?? {},
      lastDirectives: raw.lastDirectives ?? {},
      exploredChunks: raw.exploredChunks ?? [],
      milestones:     raw.milestones     ?? [],
    };
  } catch (_) {
    return {
      phase: 0, phaseStartedAt: new Date().toISOString(),
      goals: {}, lastDirectives: {},
      exploredChunks: [], milestones: [],
    };
  }
}

function writeTaskState(state) {
  try {
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(TASK_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (_) {}
}

// ── RCON helper — teleport NexusEye to elevated position ─────────────────
function rconCommand(command) {
  return new Promise((resolve) => {
    const RCON_HOST = '127.0.0.1';
    const RCON_PORT = 25575;
    const RCON_PASS = process.env.RCON_PASS || 'ailab743915';

    const client = net.createConnection(RCON_PORT, RCON_HOST);
    let buf = Buffer.alloc(0);

    function buildPacket(id, type, payload) {
      const payloadBuf = Buffer.from(payload + '\x00\x00', 'utf8');
      const pkt = Buffer.allocUnsafe(4 + 4 + 4 + payloadBuf.length);
      pkt.writeInt32LE(8 + payloadBuf.length, 0);
      pkt.writeInt32LE(id, 4);
      pkt.writeInt32LE(type, 8);
      payloadBuf.copy(pkt, 12);
      return pkt;
    }

    let authed = false;
    client.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0) + 4;
        if (buf.length < len) break;
        const responseId = buf.readInt32LE(4);
        buf = buf.subarray(len);
        if (!authed) {
          if (responseId === -1) {
            log('[RCON] Authentication failed — check RCON password');
            client.destroy();
            resolve();
            return;
          }
          authed = true;
          client.write(buildPacket(2, 2, command));
        } else {
          client.end();
          resolve();
        }
      }
    });

    client.on('connect', () => client.write(buildPacket(1, 3, RCON_PASS)));
    client.on('error', (e) => { log(`[RCON] Command failed: ${e.message}`); resolve(); });
    client.on('close', resolve);
    setTimeout(() => { client.destroy(); resolve(); }, 5000);
  });
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
    if (!viewerStarted) {
      try {
        mineflayerViewer(eyeBot, { port: VIEWER_PORT, firstPerson: false });
        log(`[EyeBot] prismarine-viewer on :${VIEWER_PORT}`);
        viewerStarted = true;
      } catch (e) {
        log(`[EyeBot] Viewer failed to start: ${e.message}`);
      }
    }
    // Set spectator mode so NexusEye floats and is invisible, then teleport up and look down
    setTimeout(async () => {
      const pos = eyeBot?.entity?.position;
      await rconCommand('/gamemode spectator NexusEye');
      log('[EyeBot] Set to spectator mode');
      if (pos) {
        // Y+5 just above terrain — bot looks straight down, so third-person camera
        // places itself directly above, giving a top-down overhead view
        await rconCommand(`/tp NexusEye ${Math.round(pos.x)} ${Math.round(pos.y + 5)} ${Math.round(pos.z)}`);
        log('[EyeBot] Teleported to Y+5 above terrain');
      }
      setTimeout(() => {
        if (eyeBot) {
          eyeBot.look(0, Math.PI / 2, false); // straight down → camera goes above
          log('[EyeBot] Bot looking down → third-person camera overhead');
        }
      }, 2000);
    }, 3000);
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
  try {
    if (browser) { try { await browser.close(); } catch (_) {} }
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
    // Give prismarine-viewer extra time to spin up its WebGL scene before navigating
    await new Promise(r => setTimeout(r, 15_000));
    await page.goto(`http://127.0.0.1:${VIEWER_PORT}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Additional wait for WebGL canvas to render first frame
    await new Promise(r => setTimeout(r, 5_000));
    log('[Puppeteer] Viewer page loaded');
    browser.on('disconnected', () => {
      log('[Puppeteer] Browser disconnected — restarting in 15s');
      browser = null;
      page = null;
      setTimeout(startBrowser, 15_000);
    });
  } catch (e) {
    log(`[Puppeteer] Failed to start: ${e.message} — retrying in 30s`);
    browser = null;
    page = null;
    setTimeout(startBrowser, 30_000);
  }
}

// ── Screenshot ────────────────────────────────────────────────────────────
async function captureFrame() {
  if (!page) return null;
  try {
    // Hard timeout: if screenshot hangs >15s the page is stale — null it out and restart
    const buf = await Promise.race([
      page.screenshot({ type: 'png', encoding: 'binary' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('screenshot timeout')), 15_000)),
    ]);
    return Buffer.from(buf);
  } catch (e) {
    log(`[Screenshot] Failed: ${e.message} — marking page stale`);
    page = null;
    if (browser && !browser.disconnected) {
      setTimeout(startBrowser, 5_000);
    }
    return null;
  }
}

// ── Ollama HTTP helper ────────────────────────────────────────────────────
function ollamaPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '10.0.0.69',
      port: 11434,
      path: endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: 180_000,
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON parse failed: ${raw.slice(0, 300)}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama request timed out')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Vision — qwen2.5vl:7b ────────────────────────────────────────────────
async function describeFrame(pngBuffer) {
  if (!pngBuffer) return 'No visual data available this cycle.';
  const b64 = pngBuffer.toString('base64');
  try {
    const res = await ollamaPost('/api/generate', {
      model: VISION_MODEL,
      prompt: 'This is a screenshot from a Minecraft world observed by an AI orchestrator. Describe in 2-3 sentences: what terrain or structures are visible, and whether any player-like figures appear active or idle.',
      images: [b64],
      stream: false,
      options: { num_predict: 150 },
    });
    return res.response?.trim() || 'Vision model returned empty response.';
  } catch (e) {
    log(`[Vision] Error: ${e.message}`);
    return 'Vision unavailable this cycle.';
  }
}

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
    log(`[MindServer] Agents: ${agents.map(a => a.name).join(', ')}`);
  });

  let eyebotCentered = false;
  socket.on('state-update', (states) => {
    const arr = Array.isArray(states) ? states : Object.values(states);
    arr.forEach(s => { if (s?.name) agentStates[s.name] = s; });

    // On first state-update with position data, re-center NexusEye above agent cluster
    if (!eyebotCentered && eyeBot) {
      const positions = arr
        .filter(s => s?.gameplay?.position)
        .map(s => s.gameplay.position);
      if (positions.length > 0) {
        const cx = Math.round(positions.reduce((a, p) => a + p.x, 0) / positions.length);
        const cz = Math.round(positions.reduce((a, p) => a + p.z, 0) / positions.length);
        const cy = Math.round(Math.max(...positions.map(p => p.y)) + 5);
        rconCommand(`/tp NexusEye ${cx} ${cy} ${cz}`)
          .then(() => {
            log(`[EyeBot] Re-centered above agents at (${cx}, ${cy}, ${cz})`);
            setTimeout(() => { if (eyeBot) eyeBot.look(0, Math.PI / 2, false); }, 1000);
            eyebotCentered = true;
          });
      }
    }
  });

  socket.on('connect_error', (e) => log(`[MindServer] Connect error: ${e.message}`));

  return socket;
}

// ── Log tail ──────────────────────────────────────────────────────────────
function readLastLines(filePath, n = 50) {
  try {
    const MAX_BYTES = 32 * 1024;
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return '';
    const readBytes = Math.min(stat.size, MAX_BYTES);
    const buf = Buffer.allocUnsafe(readBytes);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, readBytes, stat.size - readBytes);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch (_) {
    return '';
  }
}

// ── Agent long-term memory retrieval from ChromaDB ────────────────────────
const CHROMA_BASE = 'http://localhost:8000/api/v2/tenants/default_tenant/databases/default_database';
let _chromaCols = null; // cached collection list, refreshed every 10 min
let _chromaColsTs = 0;

async function getChromaCols() {
  if (Date.now() - _chromaColsTs < 10 * 60 * 1000 && _chromaCols) return _chromaCols;
  try {
    const r = await fetch(`${CHROMA_BASE}/collections`);
    _chromaCols = await r.json();
    _chromaColsTs = Date.now();
  } catch (_) { _chromaCols = []; }
  return _chromaCols || [];
}

async function queryAgentMemories(queryText) {
  try {
    // Embed the query via nomic-embed-text on DGX
    const embRes = await fetch('http://10.0.0.69:11434/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: queryText }),
    });
    const embData = await embRes.json();
    if (!embData.embedding) return '';

    const cols = await getChromaCols();
    const lines = [];

    for (const agentName of Object.keys(AGENT_ROLES)) {
      const colName = `${agentName.toLowerCase()}_memory`;
      const col = cols.find(c => c.name === colName);
      if (!col?.id) continue;

      const qRes = await fetch(`${CHROMA_BASE}/collections/${col.id}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query_embeddings: [embData.embedding], n_results: 3 }),
      });
      const qData = await qRes.json();
      const docs = qData.documents?.[0]?.filter(Boolean) || [];
      if (docs.length > 0) lines.push(`${agentName}: ${docs.join('; ')}`);
    }
    return lines.join('\n');
  } catch (e) {
    log(`[Memory] Query error: ${e.message}`);
    return '';
  }
}

// ── Reasoning — qwen2.5:7b ────────────────────────────────────────────────
function buildAgentContext() {
  return Object.keys(AGENT_ROLES).map(name => {
    const s = agentStates[name];
    if (!s) return `${name} (${AGENT_ROLES[name]}): no data yet`;
    const gp = s.gameplay;
    const pos = gp?.position
      ? `pos=(${Math.round(gp.position.x)},${Math.round(gp.position.y)},${Math.round(gp.position.z)})`
      : 'pos=unknown';
    const task = s.action?.current || 'idle';
    const inv = s.inventory?.counts
      ? Object.entries(s.inventory.counts).slice(0, 5).map(([k, v]) => `${k}×${v}`).join(', ') || 'empty'
      : 'unknown';
    return `${name} (${AGENT_ROLES[name]}): ${pos}, task="${task}", inventory=[${inv}]`;
  }).join('\n');
}

async function getDirectives(visualDescription, recentLogs, agentMemories = '', taskState = {}, phaseBrief = {}) {
  const agentCtx = buildAgentContext();
  const { phaseName = 'Unknown', phaseFocus = '', bottlenecks = [], assignments = {} } = phaseBrief;

  // Build assignment block for LLM
  const assignmentBlock = Object.entries(assignments).map(([name, a]) => {
    return `  ${name}: ${a.task.toUpperCase()} → ${a.target} | ${a.hint}`;
  }).join('\n');

  // Build bottleneck status for LLM context
  const bottleneckBlock = bottlenecks.length > 0
    ? bottlenecks.map(b => `  ${b.label}: have ${b.have}, need ${b.need} (gap: ${b.gap})`).join('\n')
    : '  All phase thresholds met — consolidate and prepare for next phase.';

  const systemPrompt = `You are Nexus — the AI foreman for a 5-agent Minecraft survival team.

The phase engine has already decided what each agent does this tick. Your ONLY job is to write each agent's directive as a natural, specific command using their assigned task. Do NOT change assignments. Do NOT assign different tasks. Translate assignments into directives.

DIRECTIVE RULES:
- Each directive must be ≤25 words
- Include at least one MindCraft command (!searchForBlock, !craftRecipe, !smeltItem, !tillAndSow, !equip, !attack, !goToCoordinates, etc.)
- Sound like a foreman giving a direct work order
- Reference the specific target item or action from the assignment
- Vex always guards — her directive should name who she's protecting or where to patrol

Output EXACTLY this format (no extra text):
GOALS:
Rook: [one-sentence goal for this phase, carry forward if unchanged]
Vex: [goal]
Drift: [goal]
Echo: [goal]
Sage: [goal]

DIRECTIVES:
Rook: [directive with MindCraft command]
Vex: [directive with MindCraft command]
Drift: [directive with MindCraft command]
Echo: [directive with MindCraft command]
Sage: [directive with MindCraft command]`;

  const memSection = agentMemories ? `\nAGENT MEMORIES:\n${agentMemories}\n` : '';

  const userPrompt = `CURRENT PHASE: ${taskState.phase}/9 — ${phaseName}
PHASE FOCUS: ${phaseFocus}

BOTTLENECK STATUS (what's blocking phase completion):
${bottleneckBlock}

AGENT ASSIGNMENTS (from phase engine — do not change):
${assignmentBlock}

VISUAL SNAPSHOT:
${visualDescription}
${memSection}
AGENT STATES:
${agentCtx}

RECENT LOG (last 50 lines):
${recentLogs.slice(-2000)}

Write GOALS then DIRECTIVES now.`;

  try {
    const res = await ollamaPost('/api/chat', {
      model: REASON_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      stream: false,
      options: { num_predict: 500 },
    });
    const raw = res.message?.content?.trim() || '';
    log(`[Reason] Response:\n${raw}`);
    return parseOrchResponse(raw);
  } catch (e) {
    log(`[Reason] Error: ${e.message}`);
    return { directives: [], updatedGoals: {} };
  }
}

// ── Response parser — handles GOALS + DIRECTIVES two-section format ───────
function parseOrchResponse(raw) {
  const known = new Set(Object.keys(AGENT_ROLES));
  const directives = [];
  const updatedGoals = {};
  let section = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (/^GOALS:/i.test(trimmed))      { section = 'goals';      continue; }
    if (/^DIRECTIVES:/i.test(trimmed)) { section = 'directives'; continue; }
    const m = trimmed.match(/^([A-Za-z]+):\s*(.+)$/);
    if (!m || !known.has(m[1])) continue;
    const [, name, text] = m;
    if (section === 'goals')      updatedGoals[name] = text.trim();
    if (section === 'directives') directives.push({ agent: name, message: text.trim() });
  }
  return { directives, updatedGoals };
}

function sendDirective(agent, message) {
  if (!msSocket?.connected) {
    log(`[Send] MindServer not connected — skipping directive for ${agent}`);
    return;
  }
  msSocket.emit('send-message', agent, { from: 'Nexus', message });
  log(`[Directive] → ${agent}: ${message}`);
}

// ── NexusEye orbit — reposition each tick for varied visual coverage ──────
async function orbitEyeBot() {
  if (!eyeBot) return;

  // Compute centroid of all agents with known positions
  const positions = Object.values(agentStates).filter(s => s?.gameplay?.position).map(s => s.gameplay.position);
  if (positions.length === 0) return;

  const cx = positions.reduce((a, p) => a + p.x, 0) / positions.length;
  const cz = positions.reduce((a, p) => a + p.z, 0) / positions.length;
  const cy = Math.max(...positions.map(p => p.y));

  // Advance orbit angle
  orbitAngle = (orbitAngle + ORBIT_STEP) % 360;
  const rad = orbitAngle * Math.PI / 180;

  const ex = Math.round(cx + ORBIT_RADIUS * Math.cos(rad));
  const ez = Math.round(cz + ORBIT_RADIUS * Math.sin(rad));
  const ey = Math.round(cy + ORBIT_HEIGHT);

  await rconCommand(`/tp NexusEye ${ex} ${ey} ${ez}`);

  // Look toward centroid with an oblique downward angle
  await new Promise(r => setTimeout(r, 1000));
  if (eyeBot) {
    const yaw   = Math.atan2(cz - ez, cx - ex);
    const dist  = Math.sqrt((cx - ex) ** 2 + (cz - ez) ** 2);
    const pitch = Math.atan2(ORBIT_HEIGHT, dist); // tilts down toward agents
    eyeBot.look(yaw, pitch, false);
  }

  log(`[EyeBot] Orbit ${orbitAngle}° → (${ex}, ${ey}, ${ez}) looking toward centroid (${Math.round(cx)}, ${Math.round(cz)})`);
}

// ── Main loop ─────────────────────────────────────────────────────────────
let loopWatchdog = null;
let loopCount = 0;
const BROWSER_RESTART_EVERY = 30; // restart Chrome every 30 loops (~30 min) to prevent memory leak

async function runLoop() {
  if (loopRunning) {
    log('[Loop] Previous tick still running — skipping');
    return;
  }
  loopRunning = true;
  // Watchdog: if the loop runs for >90s something is hung — force-unlock
  loopWatchdog = setTimeout(() => {
    log('[Loop] Watchdog triggered — force-resetting loopRunning after 90s');
    loopRunning = false;
  }, 90_000);
  loopCount++;
  log('--- Loop tick ---');

  // Periodically restart Chrome to prevent memory accumulation
  if (loopCount % BROWSER_RESTART_EVERY === 0) {
    log(`[Browser] Scheduled restart at loop ${loopCount} — freeing memory`);
    try {
      if (browser) { await browser.close().catch(() => {}); }
    } catch (_) {}
    browser = null;
    page = null;
    await startBrowser();
  }

  try {
    // Move NexusEye to next orbit position before capturing the frame
    await orbitEyeBot();
    // Pause so prismarine-viewer WebGL re-renders the new angle before screenshot
    await new Promise(r => setTimeout(r, 3000));

    const frame = await captureFrame();
    if (frame) {
      lastFrame = frame;
      try { fs.writeFileSync('/tmp/nexus-frame.png', frame); } catch (_) {}
    }

    const visual = await describeFrame(lastFrame);
    log(`[Vision] ${visual}`);

    const recentLogs = readLastLines(MC_LOG, 50);

    // Query long-term memory for context relevant to what we're currently seeing
    const agentMemories = await queryAgentMemories(visual);
    if (agentMemories) log(`[Memory] Retrieved facts: ${agentMemories.split('\n').length} lines`);

    // Load persistent task state
    const taskState = readTaskState();

    // ── Phase engine ──────────────────────────────────────────────────────
    // 1. Check current phase against live inventory
    const { phase, phaseName, phaseFocus, conditions } = checkPhase(agentStates);

    // 2. Detect phase advancement and log milestones
    if (phase > taskState.phase) {
      const prevName = PHASES_FOR_LOG[taskState.phase] || `Phase ${taskState.phase}`;
      log(`[Phase] *** MILESTONE: "${prevName}" complete → advancing to Phase ${phase} (${phaseName}) ***`);
      taskState.milestones.push({
        phase:       taskState.phase,
        name:        prevName,
        completedAt: new Date().toISOString(),
      });
      taskState.phaseStartedAt = new Date().toISOString();
    }

    // 3. Emergency regression: if Phase 8+ and armor count drops below 10, regress to Phase 6
    const armorCount = conditions.find(c => c.label === 'armor equipped')?.have ?? null;
    if (phase >= 8 && armorCount !== null && armorCount < 10) {
      log(`[Phase] EMERGENCY: armor count ${armorCount} < 10 — regressing to Phase 6 (Armor and Weapons)`);
      taskState.phase = 6;
    } else {
      taskState.phase = phase;
    }

    // 4. Get bottlenecks and dynamic agent assignments from phase engine
    const bottlenecks = getBottlenecks(taskState.phase, agentStates);
    const assignments = assignAgents(bottlenecks, agentStates, taskState.phase);

    // 5. Update exploration tracker from current agent positions
    taskState.exploredChunks = markVisited(agentStates, taskState.exploredChunks);

    const logPhaseName = PHASES_FOR_LOG[taskState.phase] || phaseName;
    log(`[Phase] ${logPhaseName} (${taskState.phase}/9) | bottlenecks: ${bottlenecks.map(b => `${b.label} ${b.have}/${b.need}`).join(', ') || 'none'}`);
    log(`[Phase] Assignments: ${Object.entries(assignments).map(([n, a]) => `${n}=${a.task}:${a.target}`).join(', ')}`);

    const phaseBrief = { phaseName, phaseFocus, bottlenecks, assignments };
    const { directives, updatedGoals } = await getDirectives(visual, recentLogs, agentMemories, taskState, phaseBrief);

    // Persist updated state
    const lastDirectives = {};
    directives.forEach(d => { lastDirectives[d.agent] = d.message; });
    writeTaskState({
      ...taskState,
      goals:          { ...taskState.goals, ...updatedGoals },
      lastDirectives: { ...taskState.lastDirectives, ...lastDirectives },
    });
    if (Object.keys(updatedGoals).length > 0) {
      log(`[Phase] Goals updated: ${Object.keys(updatedGoals).map(n => `${n}="${updatedGoals[n].slice(0, 40)}"`).join(', ')}`);
    }

    if (directives.length === 0) {
      log('[Act] No directives parsed this cycle');
    } else {
      // Stagger dispatch so agents enter the Ollama queue one at a time.
      const cfg = readLiveConfig();
      const staggerMs = cfg.directiveStaggerMs ?? Math.min(15000, Math.floor((cfg.intervalMs ?? INTERVAL_MS) / directives.length));
      for (let i = 0; i < directives.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, staggerMs));
        sendDirective(directives[i].agent, directives[i].message);
      }
      log(`[Act] Sent ${directives.length} directives with ${staggerMs}ms stagger`);
    }
  } catch (e) {
    log(`[Loop] Unhandled error: ${e.stack || e.message}`);
  } finally {
    clearTimeout(loopWatchdog);
    loopRunning = false;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    log('=== Nexus Orchestrator starting ===');
    log(`Interval: ${INTERVAL_MS}ms | Vision: ${VISION_MODEL} | Reason: ${REASON_MODEL}`);

    startEyeBot();
    msSocket = connectMindServer();

    // Give eye-bot time to spawn before launching browser
    await new Promise(r => setTimeout(r, 12_000));
    await startBrowser();
    log('[Init] All systems ready — starting loop');

    // Self-scheduling loop — reads intervalMs from live config on each tick
    // so the dashboard can change it without restarting the process

    // Write default config if file doesn't exist
    if (!fs.existsSync(CONFIG_FILE)) {
      writeLiveConfig({ intervalMs: INTERVAL_MS, visionModel: VISION_MODEL, reasonModel: REASON_MODEL });
    }

    let _loopTimer = null;
    function scheduleLoop(delayMs) {
      if (_loopTimer) clearTimeout(_loopTimer);
      _loopTimer = setTimeout(async () => {
        await runLoop();
        const cfg = readLiveConfig();
        scheduleLoop(cfg.intervalMs ?? INTERVAL_MS);
      }, delayMs);
    }
    scheduleLoop(5_000); // first tick after 5s

    // Graceful shutdown
    async function shutdown(signal) {
      log(`[Shutdown] Received ${signal} — cleaning up`);
      if (browser) await browser.close().catch(() => {});
      if (eyeBot) eyeBot.end('shutdown');
      if (msSocket) msSocket.disconnect();
      process.exit(0);
    }
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  })();
}
