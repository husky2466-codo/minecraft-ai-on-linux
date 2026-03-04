import { io } from 'socket.io-client';

const MINDSERVER_URL = 'http://10.0.0.10:8080';

let _socket = null;

export function sendCommand(event, ...args) {
  if (_socket?.connected) {
    _socket.emit(event, ...args);
  } else {
    console.warn('[MindServer] Cannot send command — not connected');
  }
}

// agentStates: { AgentName: fullStateObject }
export const agentStates = {};
export const agentList = [];

const updateListeners = [];

export function onAgentUpdate(cb) {
  updateListeners.push(cb);
}

export function startMindServerBridge() {
  const socket = io(MINDSERVER_URL, {
    reconnection: true,
    reconnectionDelay: 3000,
  });
  _socket = socket;

  socket.on('connect', () => {
    console.log('[MindServer] Connected to', MINDSERVER_URL);
    socket.emit('listen-to-agents');
  });

  socket.on('disconnect', () => {
    console.log('[MindServer] Disconnected — will reconnect');
  });

  socket.on('agents-status', (agents) => {
    // Clear in-place to preserve the exported array reference
    agentList.length = 0;
    agents.forEach(a => agentList.push(a));
    updateListeners.forEach(cb => cb('agents-status', agents));
  });

  socket.on('state-update', (states) => {
    // states may be array or object keyed by name
    const arr = Array.isArray(states) ? states : Object.values(states);
    arr.forEach(state => {
      if (state?.name) agentStates[state.name] = state;
    });
    updateListeners.forEach(cb => cb('agent-states', agentStates));
  });

  socket.on('connect_error', (err) => {
    console.warn('[MindServer] Connection error:', err.message);
  });

  return socket;
}
