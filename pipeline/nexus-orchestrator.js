'use strict';
const mineflayer = require('mineflayer');
const { mineflayer: mineflayerViewer } = require('prismarine-viewer');
const puppeteer = require('puppeteer');
const { io } = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

// ── Config ────────────────────────────────────────────────────────────────
const MC_HOST        = '127.0.0.1';
const MC_PORT        = 25565;
const VIEWER_PORT    = 3099;
const MINDSERVER_URL = 'http://127.0.0.1:8080';
const VISION_MODEL   = 'qwen2.5vl:7b';
const REASON_MODEL   = 'qwen2.5:7b';
const INTERVAL_MS    = parseInt(process.env.NEXUS_INTERVAL_MS || '30000', 10);
const MC_LOG         = path.join(process.env.HOME, 'mindcraft.log');

const AGENT_ROLES = {
  Rook:  'gatherer — mines resources and fills storage chests',
  Vex:   'combat — guards the base and eliminates threats',
  Drift: 'explorer — maps new terrain and finds biomes/resources',
  Echo:  'coordinator — tracks agent relationships and shares resources',
  Sage:  'engineer — crafts tools, builds structures, manages inventory',
};

// ── State ─────────────────────────────────────────────────────────────────
let eyeBot      = null;
let browser     = null;
let page        = null;
let agentStates = {};
let agentList   = [];
let lastFrame   = null;
let loopRunning = false;
let msSocket    = null;

// ── Logging ───────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
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
    try {
      mineflayerViewer(eyeBot, { port: VIEWER_PORT, firstPerson: false });
      log(`[EyeBot] prismarine-viewer on :${VIEWER_PORT}`);
    } catch (e) {
      log(`[EyeBot] Viewer failed to start: ${e.message}`);
    }
    // Set spectator mode so NexusEye floats and is invisible, then teleport up and look down
    setTimeout(async () => {
      const pos = eyeBot?.entity?.position;
      await rconCommand('/gamemode spectator NexusEye');
      await rconCommand('/gamerule doDaylightCycle false');
      await rconCommand('/time set day');
      log('[EyeBot] Set to spectator mode, locked time to day');
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
        .filter(s => s?.position)
        .map(s => s.position);
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
    const pos = s.position
      ? `pos=(${Math.round(s.position.x)},${Math.round(s.position.y)},${Math.round(s.position.z)})`
      : 'pos=unknown';
    const task = s.task || s.current_action || 'idle';
    const inv = s.inventory
      ? Object.entries(s.inventory).slice(0, 5).map(([k, v]) => `${k}×${v}`).join(', ') || 'empty'
      : 'unknown';
    return `${name} (${AGENT_ROLES[name]}): ${pos}, task="${task}", inventory=[${inv}]`;
  }).join('\n');
}

async function getDirectives(visualDescription, recentLogs, agentMemories = '') {
  const agentCtx = buildAgentContext();

  const systemPrompt = `You are Nexus — the autonomous AI orchestrator for a 5-agent Minecraft team. You observe the world every 60 seconds and actively direct all agents like a hands-on manager.

ALWAYS issue a directive for EVERY agent — even those working, to reinforce or refine their task.
Be specific: reference resources, locations, or other agents by name.
Keep each directive under 25 words. Use imperative commands.
Prioritize: (1) active threats/safety, (2) full storage needs emptying, (3) needed materials, (4) base construction, (5) exploration.

Format EXACTLY — one line per agent, all five:
Rook: directive
Vex: directive
Drift: directive
Echo: directive
Sage: directive`;

  const memSection = agentMemories
    ? `\nAGENT MEMORIES (relevant past events):\n${agentMemories}\n`
    : '';

  const userPrompt = `VISUAL SNAPSHOT (what NexusEye sees from above):
${visualDescription}
${memSection}
AGENT STATES:
${agentCtx}

RECENT LOG (last 50 lines):
${recentLogs.slice(-2000)}

Issue a directive for every agent now. All five lines required.`;

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

// ── Directive parser + sender ─────────────────────────────────────────────
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

function sendDirective(agent, message) {
  if (!msSocket?.connected) {
    log(`[Send] MindServer not connected — skipping directive for ${agent}`);
    return;
  }
  msSocket.emit('send-message', agent, { from: 'Nexus', message });
  log(`[Directive] → ${agent}: ${message}`);
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

    const raw = await getDirectives(visual, recentLogs, agentMemories);
    log(`[Reason] Response:\n${raw}`);

    const directives = parseDirectives(raw);
    if (directives.length === 0) {
      log('[Act] No directives this cycle — agents on track');
    } else {
      for (const { agent, message } of directives) {
        sendDirective(agent, message);
      }
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
    const CONFIG_FILE = path.join(process.env.HOME, 'nexus-config.json');
    function readLiveConfig() {
      try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { return {}; }
    }
    function writeLiveConfig(cfg) {
      try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch (_) {}
    }
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
