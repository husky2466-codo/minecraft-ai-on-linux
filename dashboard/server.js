import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { startMindServerBridge, agentStates, agentList, onAgentUpdate } from './src/mindserver-bridge.js';
import { tailLog, readRemoteFile, runRemoteCommand } from './src/log-streamer.js';
import { parseMindcraftLine, metrics } from './src/metrics-engine.js';
import { sendRcon } from './src/rcon-client.js';
import { sendCommand } from './src/mindserver-bridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const MINDCRAFT_PATH = '/home/myroproductions/Projects/minecraft-ai-on-linux/mindcraft';
const CHROMA_COLLECTIONS = ['rook_memory', 'vex_memory', 'sage_memory', 'echo_memory', 'drift_memory'];
// Returns current live agent names from MindServer (falls back to all known if empty)
function liveAgentNames() { return agentList.map(a => a.name); }
function isValidAgentName(name) { return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name); }

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Broadcast to all connected WebSocket clients
export function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  ws.on('close', () => console.log('[WS] Client disconnected'));
  ws.on('error', (err) => console.error('[WS] Client error:', err.message));
});

// Start MindServer bridge
const mindServerSocket = startMindServerBridge();
app.locals.mindServerSocket = mindServerSocket;
onAgentUpdate((type, data) => broadcast(type, data));

// REST endpoint for current agent state snapshot
app.get('/api/agents', (req, res) => res.json({ agents: agentStates, list: agentList }));

// Tail mindcraft log — parse for metrics and stream to clients
tailLog('/home/myroproductions/mindcraft.log', (line) => {
  const parsed = parseMindcraftLine(line);
  if (parsed) broadcast('metric-update', parsed);
  broadcast('log-line', { source: 'mindcraft', line });
});

// Tail minecraft server log
tailLog('/home/myroproductions/minecraft-server/server.log', (line) => {
  broadcast('log-line', { source: 'minecraft', line });
});

// Tail nexus orchestrator log — stream to dashboard
tailLog('/home/myroproductions/nexus-orchestrator.log', (line) => {
  broadcast('log-line', { source: 'nexus', line });
});

// Metrics REST endpoint
app.get('/api/metrics', (req, res) => res.json(metrics));

// --- Orchestrator (Nexus) state ---
// Returns orchestrator status derived from its log (no longer an in-game bot)
app.get('/api/orchestrator', async (req, res) => {
  let lastTick = null, lastVision = null, running = false;
  try {
    const { stdout } = await runRemoteCommand(
      'tail -100 /home/myroproductions/nexus-orchestrator.log 2>/dev/null'
    );
    const lines = stdout.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lastTick && lines[i].includes('--- Loop tick ---')) lastTick = lines[i].match(/\[(.+?)\]/)?.[1];
      if (!lastVision && lines[i].includes('[Vision]')) lastVision = lines[i].replace(/.*\[Vision\]\s*/, '');
    }
    // Running = a loop tick appeared in the last 5 minutes
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    running = lines.some(l => {
      if (!l.includes('--- Loop tick ---')) return false;
      const m = l.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
      return m ? new Date(m[1]).getTime() > fiveMinAgo : false;
    });
  } catch (_) {}
  res.json({ running, lastTick, lastVision, loopInterval: 60 });
});

// --- NexusEye latest snapshot ---
app.get('/api/nexus/frame', async (req, res) => {
  try {
    const { stdout, code } = await runRemoteCommand('base64 -w0 /tmp/nexus-frame.png 2>/dev/null');
    if (code !== 0 || !stdout.trim()) return res.status(404).json({ error: 'No frame available' });
    const buf = Buffer.from(stdout.trim(), 'base64');
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Nexus orchestrator process control ---
const NEXUS_START = [
  'pgrep -f nexus-orchestrator.js | xargs -r kill -9',
  'sleep 2',
  `cd /home/myroproductions/Projects/minecraft-ai-on-linux/pipeline`,
  'nohup node nexus-orchestrator.js > /home/myroproductions/nexus-orchestrator.log 2>&1 &',
  'echo "Nexus restarted"',
].join('; ');

app.post('/api/control/restart-nexus', async (req, res) => {
  try {
    const { stdout, stderr } = await runRemoteCommand(NEXUS_START);
    res.json({ ok: true, stdout, stderr });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Agent memory files ---
app.get('/api/memories/:agent', async (req, res) => {
  const { agent } = req.params;
  if (!isValidAgentName(agent)) return res.status(404).json({ error: 'Unknown agent' });
  try {
    const content = await readRemoteFile(`${MINDCRAFT_PATH}/bots/${agent}/memory.json`);
    res.json(JSON.parse(content));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- ChromaDB proxy (v2 API) ---
const CHROMA = 'http://10.0.0.10:8000/api/v2/tenants/default_tenant/databases/default_database';

app.get('/api/chromadb/collections', async (req, res) => {
  try {
    const r = await fetch(`${CHROMA}/collections`);
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/chromadb/search', async (req, res) => {
  const { collection, query, n = 10 } = req.body;
  if (!collection || !query) return res.status(400).json({ error: 'collection and query required' });
  if (!CHROMA_COLLECTIONS.includes(collection)) return res.status(400).json({ error: 'Unknown collection' });
  try {
    const r = await fetch(`${CHROMA}/collections/${collection}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query_texts: [query], n_results: n }),
    });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/chromadb/get/:collection', async (req, res) => {
  if (!CHROMA_COLLECTIONS.includes(req.params.collection)) return res.status(404).json({ error: 'Unknown collection' });
  try {
    const r = await fetch(`${CHROMA}/collections/${req.params.collection}/get`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 50 }),
    });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
const PROJECT = '/home/myroproductions/Projects/minecraft-ai-on-linux';
const NODE = '$HOME/.nvm/versions/node/v22.22.0/bin/node';
const PATH_PREFIX = 'PATH=$HOME/.nvm/versions/node/v22.22.0/bin:$HOME/.local/bin:$PATH';

// STOP: kill MindCraft (port 8080), agent children, queue proxy, Minecraft, ChromaDB
// ALL kills use port lookup — pkill -f self-matches the SSH exec shell's argv and kills the session
const STOP_CMD = [
  // MindCraft (8080) + kill its entire process group to catch all init_agent.js children
  'MCPID=$(ss -Htlnp src :8080 | grep -oP "pid=\\K[0-9]+" | head -1)',
  '[ -n "$MCPID" ] && MCPGID=$(ps -o pgid= -p $MCPID 2>/dev/null | tr -d " ") && [ -n "$MCPGID" ] && kill -9 -- -$MCPGID 2>/dev/null',
  // Queue proxy (11435)
  'QPID=$(ss -Htlnp src :11435 | grep -oP "pid=\\K[0-9]+" | head -1)',
  '[ -n "$QPID" ] && kill -9 $QPID 2>/dev/null',
  // Minecraft server (25565) — graceful SIGTERM so world saves
  'MSVPID=$(ss -Htlnp src :25565 | grep -oP "pid=\\K[0-9]+" | head -1)',
  '[ -n "$MSVPID" ] && kill $MSVPID 2>/dev/null',
  // ChromaDB (8000)
  'CHRPID=$(ss -Htlnp src :8000 | grep -oP "pid=\\K[0-9]+" | head -1)',
  '[ -n "$CHRPID" ] && kill $CHRPID 2>/dev/null',
  // Nexus orchestrator
  'NXPID=$(pgrep -f "nexus-orchestrator.js" | head -1)',
  '[ -n "$NXPID" ] && kill -9 $NXPID 2>/dev/null',
  'sleep 2',
  'echo "Stopped"',
].join('; ');

// START: wrap the full sequence in a detached nohup bash -c so SSH exec returns immediately.
// Without this, the sleep 30 for Minecraft holds the SSH channel open until it times out.
// Join with newlines — bash rejects `cmd &; next` (& and ; both terminate, can't be adjacent)
const START_INNER = [
  'nohup bash ~/chromadb/start.sh > ~/chromadb/chroma.log 2>&1 &',
  'sleep 5',
  `cd ~/minecraft-server`,
  `nohup java -Xmx8G -Xms4G -jar server.jar nogui > ~/minecraft-server/server.log 2>&1 &`,
  'sleep 30',
  `cd ${PROJECT}`,
  `nohup ${NODE} pipeline/ollama-queue.js > ~/ollama-queue.log 2>&1 &`,
  'sleep 2',
  `cd ${PROJECT}/mindcraft`,
  `${PATH_PREFIX} nohup ${NODE} main.js > ~/mindcraft.log 2>&1 &`,
  'sleep 15',
  `cd ${PROJECT}/pipeline`,
  `nohup ${NODE} nexus-orchestrator.js > ~/nexus-orchestrator.log 2>&1 &`,
  'echo "Stack started at $(date)"',
].join('\n');

// Single-quote the inner script (none of the parts contain single quotes)
const START_CMD = `nohup bash -c '${START_INNER}' > ~/stack-start.log 2>&1 & echo "Stack launching"`;

const STACK_COMMANDS = {
  start:   START_CMD,
  stop:    STOP_CMD,
  restart: `${STOP_CMD}; sleep 2; ${START_CMD}`,
};

app.post('/api/control/:action', async (req, res) => {
  const { action } = req.params;
  if (!STACK_COMMANDS[action]) return res.status(400).json({ error: 'Unknown action. Use: start, stop, restart' });
  try {
    const { stdout, stderr } = await runRemoteCommand(STACK_COMMANDS[action]);
    res.json({ ok: true, stdout, stderr });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Agent control via MindServer ---
const VALID_AGENT_ACTIONS = ['restart', 'stop', 'start'];

app.post('/api/agents/:name/:action', (req, res) => {
  const { name, action } = req.params;
  if (!isValidAgentName(name)) return res.status(404).json({ error: 'Unknown agent' });
  if (!VALID_AGENT_ACTIONS.includes(action)) return res.status(400).json({ error: 'Invalid action. Use: restart, stop, start' });
  const sent = sendCommand(`${action}-agent`, name);
  if (!sent) return res.status(503).json({ error: 'MindServer not connected' });
  res.json({ ok: true, agent: name, action });
});

// Inject a message into an agent as if sent by a player — pauses self-prompt, triggers response
app.post('/api/agents/:name/message', (req, res) => {
  const { name } = req.params;
  const { from = 'Operator', message } = req.body;
  if (!isValidAgentName(name)) return res.status(404).json({ error: 'Unknown agent' });
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });
  const sent = sendCommand('send-message', name, { from, message: message.trim() });
  if (!sent) return res.status(503).json({ error: 'MindServer not connected' });
  res.json({ ok: true, agent: name, from, message: message.trim() });
});

// Broadcast a message to ALL connected agents
app.post('/api/agents/broadcast/message', (req, res) => {
  const { from = 'Operator', message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });
  const names = agentList.map(a => a.name);
  let sent = 0;
  for (const name of names) {
    if (sendCommand('send-message', name, { from, message: message.trim() })) sent++;
  }
  res.json({ ok: true, sent, agents: names, from, message: message.trim() });
});

// Set an agent's active self-prompt goal by injecting a !goal command
app.post('/api/agents/:name/goal', (req, res) => {
  const { name } = req.params;
  const { goal } = req.body;
  if (!isValidAgentName(name)) return res.status(404).json({ error: 'Unknown agent' });
  if (!goal?.trim()) return res.status(400).json({ error: 'goal required' });
  const sent = sendCommand('send-message', name, { from: 'Operator', message: `!goal "${goal.trim()}"` });
  if (!sent) return res.status(503).json({ error: 'MindServer not connected' });
  res.json({ ok: true, agent: name, goal: goal.trim() });
});

// Toggle an agent mode by injecting a !setMode command
app.post('/api/agents/:name/mode', (req, res) => {
  const { name } = req.params;
  const { mode, enabled } = req.body;
  if (!isValidAgentName(name)) return res.status(404).json({ error: 'Unknown agent' });
  if (!mode) return res.status(400).json({ error: 'mode required' });
  const value = enabled ? 'true' : 'false';
  const sent = sendCommand('send-message', name, { from: 'Operator', message: `!setMode ${mode} ${value}` });
  if (!sent) return res.status(503).json({ error: 'MindServer not connected' });
  res.json({ ok: true, agent: name, mode, enabled });
});

// --- Orchestrator config (read/write nexus-config.json on remote) ---
app.get('/api/orchestrator/config', async (req, res) => {
  try {
    const { stdout } = await runRemoteCommand('cat /home/myroproductions/nexus-config.json 2>/dev/null || echo "{}"');
    res.json(JSON.parse(stdout.trim() || '{}'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orchestrator/config', async (req, res) => {
  const { intervalMs, visionModel, reasonModel } = req.body;
  const cfg = {};
  if (intervalMs)   cfg.intervalMs   = parseInt(intervalMs, 10);
  if (visionModel)  cfg.visionModel  = visionModel.trim();
  if (reasonModel)  cfg.reasonModel  = reasonModel.trim();
  try {
    const escaped = JSON.stringify(JSON.stringify(cfg));
    await runRemoteCommand(`echo ${escaped} > /home/myroproductions/nexus-config.json`);
    res.json({ ok: true, cfg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = 4000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard running at http://0.0.0.0:${PORT}`);
  console.log(`Tailscale: http://100.85.249.61:${PORT}`);
});
server.on('error', (err) => {
  console.error('[Server] Fatal:', err.message);
  process.exit(1);
});
