'use strict';
const mineflayer = require('mineflayer');
const { mineflayer: mineflayerViewer } = require('prismarine-viewer');
const puppeteer = require('puppeteer');
const { io } = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ── Config ────────────────────────────────────────────────────────────────
const MC_HOST        = '127.0.0.1';
const MC_PORT        = 25565;
const VIEWER_PORT    = 3099;
const MINDSERVER_URL = 'http://127.0.0.1:8080';
const VISION_MODEL   = 'qwen2.5vl:7b';
const REASON_MODEL   = 'qwen3.5:27b';
const INTERVAL_MS    = parseInt(process.env.NEXUS_INTERVAL_MS || '60000', 10);
const MC_LOG         = path.join(process.env.HOME, 'mindcraft.log');
const OUT_LOG        = path.join(process.env.HOME, 'nexus-orchestrator.log');

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
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(OUT_LOG, line + '\n'); } catch (_) {}
}

// ── RCON helper — teleport NexusEye to elevated position ─────────────────
function rconTeleport(x, y, z) {
  return new Promise((resolve) => {
    const net = require('net');
    const RCON_HOST = '127.0.0.1';
    const RCON_PORT = 25575;
    const RCON_PASS = 'ailab743915';

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
        const type = buf.readInt32LE(8);
        buf = buf.slice(len);
        if (!authed) {
          authed = true;
          // Send tp command
          client.write(buildPacket(2, 2, `/tp NexusEye ${Math.round(x)} ${Math.round(y + 40)} ${Math.round(z)}`));
        } else {
          client.end();
          resolve();
        }
      }
    });

    client.on('connect', () => client.write(buildPacket(1, 3, RCON_PASS)));
    client.on('error', (e) => { log(`[RCON] tp failed: ${e.message}`); resolve(); });
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
    // Teleport to elevated position for overhead view
    setTimeout(async () => {
      const pos = eyeBot.entity?.position;
      if (pos) {
        await rconTeleport(pos.x, pos.y, pos.z);
        log(`[EyeBot] Teleported to elevated position (Y+40)`);
      }
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
    await new Promise(r => setTimeout(r, 8000));
    await page.goto(`http://127.0.0.1:${VIEWER_PORT}`, { waitUntil: 'networkidle0', timeout: 30000 });
    log('[Puppeteer] Viewer page loaded');
  } catch (e) {
    log(`[Puppeteer] Failed to start: ${e.message}`);
    browser = null;
    page = null;
  }
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
      timeout: 120_000,
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

// ── Reasoning — qwen3.5:27b ───────────────────────────────────────────────
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

async function getDirectives(visualDescription, recentLogs) {
  const agentCtx = buildAgentContext();

  const systemPrompt = `You are Nexus — the autonomous orchestrator for a 5-agent Minecraft AI team.
Your only output is directives. Issue one directive per agent that needs redirecting.
Agents actively working on the right task need NO directive — omit them.
Prioritize: (1) active threats, (2) empty storage, (3) missing materials, (4) exploration, (5) building.
Keep each directive under 20 words. Be specific and use imperative commands.

Format EXACTLY as (only agents needing a directive):
AgentName: directive text`;

  const userPrompt = `VISUAL SNAPSHOT:
${visualDescription}

AGENT STATES:
${agentCtx}

RECENT LOG (last 50 lines):
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
async function runLoop() {
  if (loopRunning) {
    log('[Loop] Previous tick still running — skipping');
    return;
  }
  loopRunning = true;
  log('--- Loop tick ---');
  try {
    const frame = await captureFrame();
    if (frame) lastFrame = frame;

    const visual = await describeFrame(lastFrame);
    log(`[Vision] ${visual}`);

    const recentLogs = readLastLines(MC_LOG, 50);

    const raw = await getDirectives(visual, recentLogs);
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

    setTimeout(runLoop, 5_000);
    setInterval(runLoop, INTERVAL_MS);
  })();
}
