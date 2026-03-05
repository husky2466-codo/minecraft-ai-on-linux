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
const CHROMA_COLLECTIONS = ['rook_memory', 'vex_memory', 'sage_memory', 'echo_memory', 'drift_memory', 'nexus_memory'];
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

// Metrics REST endpoint
app.get('/api/metrics', (req, res) => res.json(metrics));

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
const CHROMA = 'http://10.0.0.10:8000/api/v2';

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

// Use semicolons (not &&) after background jobs — zsh/bash both handle this correctly
// Kill MindCraft: get PID holding port 8080 and SIGKILL it + all init_agent children
const STOP_CMD =
  'MCPID=$(ss -Htlnp src :8080 | grep -oP "pid=\\K[0-9]+" | head -1); ' +
  '[ -n "$MCPID" ] && kill -9 $MCPID 2>/dev/null; ' +
  'pkill -9 -f "init_agent.js" 2>/dev/null; ' +
  'pkill -f "server.jar" 2>/dev/null; pkill -f "chroma run" 2>/dev/null; pkill -f "ollama-queue.js" 2>/dev/null; sleep 3; echo "Stopped"';

const START_CMD =
  // ChromaDB
  `nohup bash ~/chromadb/start.sh > ~/chromadb/chroma.log 2>&1 & sleep 5; ` +
  // Minecraft server
  `cd ~/minecraft-server; nohup java -Xmx8G -Xms4G -jar server.jar nogui > server.log 2>&1 & sleep 30; ` +
  // Ollama queue proxy — serializes 7b/14b requests to prevent model-swap thrashing
  `cd ${PROJECT}; nohup ${NODE} pipeline/ollama-queue.js > ~/ollama-queue.log 2>&1 & sleep 2; ` +
  // MindCraft — all 6 agents from settings.js
  `cd ${PROJECT}/mindcraft; ${PATH_PREFIX} nohup ${NODE} main.js > ~/mindcraft.log 2>&1 & echo "Stack started"`;

const STACK_COMMANDS = {
  start:   START_CMD,
  stop:    STOP_CMD,
  restart: `${STOP_CMD}; sleep 3; ${START_CMD}`,
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

const PORT = 4000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard running at http://0.0.0.0:${PORT}`);
  console.log(`Tailscale: http://100.85.249.61:${PORT}`);
});
server.on('error', (err) => {
  console.error('[Server] Fatal:', err.message);
  process.exit(1);
});
