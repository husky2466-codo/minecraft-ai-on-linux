import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { startMindServerBridge, agentStates, agentList, onAgentUpdate } from './src/mindserver-bridge.js';

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

const PORT = 4000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard running at http://0.0.0.0:${PORT}`);
  console.log(`Tailscale: http://100.85.249.61:${PORT}`);
});
server.on('error', (err) => {
  console.error('[Server] Fatal:', err.message);
  process.exit(1);
});
