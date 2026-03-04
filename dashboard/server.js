import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { startMindServerBridge, agentStates, agentList, onAgentUpdate } from './src/mindserver-bridge.js';
import { tailLog } from './src/log-streamer.js';
import { parseMindcraftLine, metrics } from './src/metrics-engine.js';

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

const PORT = 4000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard running at http://0.0.0.0:${PORT}`);
  console.log(`Tailscale: http://100.85.249.61:${PORT}`);
});
server.on('error', (err) => {
  console.error('[Server] Fatal:', err.message);
  process.exit(1);
});
