// Rolling metrics per agent — dynamically populated as agents appear in logs
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSIST_FILE = join(__dirname, '../metrics-state.json');

function loadPersistedMetrics() {
  try {
    if (existsSync(PERSIST_FILE)) {
      const raw = readFileSync(PERSIST_FILE, 'utf8');
      const saved = JSON.parse(raw);
      // Only restore counts/commands (not raw response time arrays — trim to last 20)
      return {
        responseTimes: Object.fromEntries(
          Object.entries(saved.responseTimes || {}).map(([k, v]) => [k, v.slice(-20)])
        ),
        commandCounts: saved.commandCounts || {},
        actionResults: saved.actionResults || {},
        totalCalls: saved.totalCalls || {},
        lastActivity: saved.lastActivity || {},
      };
    }
  } catch (_) {}
  return { responseTimes: {}, commandCounts: {}, actionResults: {}, totalCalls: {}, lastActivity: {} };
}

export const metrics = loadPersistedMetrics();

function ensureAgent(name) {
  if (!metrics.responseTimes[name]) metrics.responseTimes[name] = [];
  if (!metrics.commandCounts[name]) metrics.commandCounts[name] = {};
  if (!metrics.actionResults[name]) metrics.actionResults[name] = { success: 0, fail: 0 };
  if (metrics.totalCalls[name] == null) metrics.totalCalls[name] = 0;
  if (metrics.lastActivity[name] == null) metrics.lastActivity[name] = null;
}

// Persist metrics to disk every 30s
let _persistDirty = false;
setInterval(() => {
  if (!_persistDirty) return;
  try {
    writeFileSync(PERSIST_FILE, JSON.stringify(metrics), 'utf8');
    _persistDirty = false;
  } catch (_) {}
}, 30_000);

// Track pending LLM calls: { agentName: startTs }
const pendingTimers = {};
// Track which agent is "active" based on most recent "full response" line
let lastActiveAgent = null;

export function parseMindcraftLine(line) {
  const ts = Date.now();

  // Detect LLM call start: "Awaiting local response..."
  if (line.includes('Awaiting local response')) {
    if (lastActiveAgent) {
      pendingTimers[lastActiveAgent] = ts;
    }
    return null;
  }

  // Detect LLM response end: "AgentName full response to X:" (system, player, or other agent)
  const responseMatch = line.match(/^(\w+) full response to \w+:/);
  if (responseMatch) {
    const agent = responseMatch[1];
    // Only track known agent names (capitalized, not common words)
    if (/^[A-Z]/.test(agent)) {
      ensureAgent(agent);
      lastActiveAgent = agent;
      if (pendingTimers[agent]) {
        const ms = ts - pendingTimers[agent];
        metrics.responseTimes[agent].push({ ts, ms });
        if (metrics.responseTimes[agent].length > 50) metrics.responseTimes[agent].shift();
        metrics.totalCalls[agent]++;
        metrics.lastActivity[agent] = ts;
        delete pendingTimers[agent];
        _persistDirty = true;
        return { type: 'response-time', agent, ms };
      }
    }
  }

  // Detect command execution: "parsed command: { commandName: '!xxx', args: [...] }"
  const cmdMatch = line.match(/commandName: '(![\w]+)'/);
  if (cmdMatch && lastActiveAgent) {
    const cmd = cmdMatch[1];
    ensureAgent(lastActiveAgent);
    metrics.commandCounts[lastActiveAgent][cmd] = (metrics.commandCounts[lastActiveAgent][cmd] || 0) + 1;
    _persistDirty = true;
    return { type: 'command', agent: lastActiveAgent, cmd };
  }

  // Detect action success: "Agent executed: !xxx and got: Action output:"
  const successMatch = line.match(/Agent executed: (![\w]+) and got: Action output:/);
  if (successMatch && lastActiveAgent) {
    ensureAgent(lastActiveAgent);
    metrics.actionResults[lastActiveAgent].success++;
    _persistDirty = true;
    return { type: 'action-result', agent: lastActiveAgent, result: 'success' };
  }

  // Detect action failure
  const failMatch = line.match(/Could not find|Action failed|cannot|No path found/i);
  if (failMatch && lastActiveAgent) {
    ensureAgent(lastActiveAgent);
    metrics.actionResults[lastActiveAgent].fail++;
    _persistDirty = true;
    return { type: 'action-result', agent: lastActiveAgent, result: 'fail' };
  }

  return null;
}
