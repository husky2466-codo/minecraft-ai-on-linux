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
