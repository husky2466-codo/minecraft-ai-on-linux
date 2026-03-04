// Rolling metrics per agent
export const metrics = {
  responseTimes: {},  // { AgentName: [{ ts, ms }, ...] } (last 50)
  commandCounts: {},  // { AgentName: { commandName: count } }
  actionResults: {},  // { AgentName: { success: N, fail: N } }
  totalCalls: {},     // { AgentName: N }
  lastActivity: {},   // { AgentName: timestamp }
};

const AGENTS = ['Rook', 'Vex', 'Sage', 'Echo', 'Drift'];

AGENTS.forEach(name => {
  metrics.responseTimes[name] = [];
  metrics.commandCounts[name] = {};
  metrics.actionResults[name] = { success: 0, fail: 0 };
  metrics.totalCalls[name] = 0;
  metrics.lastActivity[name] = null;
});

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

  // Detect LLM response end: "AgentName full response to system:"
  const responseMatch = line.match(/^(\w+) full response to system:/);
  if (responseMatch) {
    const agent = responseMatch[1];
    if (AGENTS.includes(agent)) {
      lastActiveAgent = agent;
      if (pendingTimers[agent]) {
        const ms = ts - pendingTimers[agent];
        metrics.responseTimes[agent].push({ ts, ms });
        if (metrics.responseTimes[agent].length > 50) metrics.responseTimes[agent].shift();
        metrics.totalCalls[agent]++;
        metrics.lastActivity[agent] = ts;
        delete pendingTimers[agent];
        return { type: 'response-time', agent, ms };
      }
    }
  }

  // Detect command execution: "parsed command: { commandName: '!xxx', args: [...] }"
  const cmdMatch = line.match(/commandName: '(![\w]+)'/);
  if (cmdMatch && lastActiveAgent) {
    const cmd = cmdMatch[1];
    metrics.commandCounts[lastActiveAgent][cmd] = (metrics.commandCounts[lastActiveAgent][cmd] || 0) + 1;
    return { type: 'command', agent: lastActiveAgent, cmd };
  }

  // Detect action success: "Agent executed: !xxx and got: Action output:"
  const successMatch = line.match(/Agent executed: (![\w]+) and got: Action output:/);
  if (successMatch && lastActiveAgent) {
    metrics.actionResults[lastActiveAgent].success++;
    return { type: 'action-result', agent: lastActiveAgent, result: 'success' };
  }

  // Detect action failure: "Could not find", "Failed", action errors
  const failMatch = line.match(/Could not find|Action failed|cannot|No path found/i);
  if (failMatch && lastActiveAgent) {
    metrics.actionResults[lastActiveAgent].fail++;
    return { type: 'action-result', agent: lastActiveAgent, result: 'fail' };
  }

  return null;
}
