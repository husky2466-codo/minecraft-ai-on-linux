'use strict';

// ── Phase definitions ─────────────────────────────────────────────────────
// Each threshold: { match: string|RegExp, count: number, label: string }
// match is tested against the aggregated inventory keys across all 5 agents.
const PHASES = [
  {
    id: 0, name: 'Shelter',
    focus: 'Chop wood, craft planks, make beds, place crafting table. Stay near spawn.',
    thresholds: [
      { match: /planks$/,        count: 64, label: 'wood planks' },
      { match: 'crafting_table', count: 1,  label: 'crafting table' },
      { match: /bed$/,           count: 4,  label: 'beds' },
    ],
  },
  {
    id: 1, name: 'Basic Tools',
    focus: 'Mine stone, craft stone pickaxes, axes, and shovels for every agent.',
    thresholds: [
      { match: 'stone_pickaxe', count: 5, label: 'stone pickaxes' },
      { match: 'stone_axe',     count: 5, label: 'stone axes' },
      { match: 'stone_shovel',  count: 5, label: 'stone shovels' },
    ],
  },
  {
    id: 2, name: 'Food Secured',
    focus: 'Till soil near water, plant seeds, pen animals, cook food.',
    thresholds: [
      { match: /^cooked_/,                          count: 64, label: 'cooked food' },
      { match: /^(wheat|carrot|potato|beetroot)$/,  count: 16, label: 'crops harvested' },
    ],
  },
  {
    id: 3, name: 'Storage System',
    focus: 'Place chests and furnaces at base, stock with coal and raw materials.',
    thresholds: [
      { match: 'chest',   count: 9,  label: 'chests' },
      { match: 'furnace', count: 3,  label: 'furnaces' },
      { match: 'coal',    count: 32, label: 'coal' },
    ],
  },
  {
    id: 4, name: 'Iron Gathering',
    focus: 'Find and mine iron ore veins near surface and shallow caves.',
    thresholds: [
      { match: 'iron_ore', count: 32, label: 'iron ore' },
    ],
  },
  {
    id: 5, name: 'Iron Age',
    focus: 'Smelt iron ore, craft iron pickaxes for every agent.',
    thresholds: [
      { match: 'iron_ingot',   count: 32, label: 'iron ingots' },
      { match: 'iron_pickaxe', count: 5,  label: 'iron pickaxes' },
    ],
  },
  {
    id: 6, name: 'Armor and Weapons',
    focus: 'Smelt more iron, craft full armor sets and swords for all agents.',
    thresholds: [
      { match: /^iron_(helmet|chestplate|leggings|boots)$/, count: 20, label: 'iron armor pieces' },
      { match: 'iron_sword', count: 5, label: 'iron swords' },
    ],
  },
  {
    id: 7, name: 'Surface Secured',
    focus: 'Equip armor on all agents, build cobblestone perimeter wall around base.',
    thresholds: [
      { match: /^iron_(helmet|chestplate|leggings|boots)$/, count: 10, label: 'armor equipped' },
      { match: /^(stone|cobblestone)$/,                     count: 64, label: 'stone for walls' },
    ],
  },
  {
    id: 8, name: 'Cave Exploration',
    focus: 'Explore unexplored underground chunks systematically. Mark territory. Find diamonds.',
    thresholds: [
      { match: 'torch',      count: 64, label: 'torches' },
      { match: /^cooked_/,   count: 32, label: 'food for exploration' },
    ],
  },
  {
    id: 9, name: 'Nether Prep',
    focus: 'Mine obsidian, craft flint and steel, build nether portal.',
    thresholds: [
      { match: 'obsidian',        count: 10, label: 'obsidian' },
      { match: 'flint_and_steel', count: 1,  label: 'flint and steel' },
      { match: /^diamond_/,       count: 2,  label: 'diamond tools' },
    ],
  },
];

// ── Bottleneck → task hint map ────────────────────────────────────────────
const BOTTLENECK_TASKS = {
  'wood planks':          { task: 'gather', target: 'oak_log',          hint: 'Chop oak trees. Use !searchForBlock oak_log then chop. Craft logs into planks.' },
  'crafting table':       { task: 'craft',  target: 'crafting_table',   hint: 'Craft a crafting table from 4 planks and place it at base.' },
  'beds':                 { task: 'craft',  target: 'bed',              hint: 'Get 3 wool from sheep (!searchForBlock sheep) and 3 planks. Craft and place beds.' },
  'stone pickaxes':       { task: 'mine',   target: 'cobblestone',      hint: 'Mine cobblestone then !craftRecipe stone_pickaxe.' },
  'stone axes':           { task: 'craft',  target: 'stone_axe',        hint: 'Craft stone axes: 3 cobblestone + 2 sticks.' },
  'stone shovels':        { task: 'craft',  target: 'stone_shovel',     hint: 'Craft stone shovels: 1 cobblestone + 2 sticks.' },
  'cooked food':          { task: 'farm',   target: 'food',             hint: 'Kill nearby animals, harvest crops, smelt in furnace to cook.' },
  'crops harvested':      { task: 'farm',   target: 'crops',            hint: 'Use !tillAndSow near water. Search for dirt/grass near water first.' },
  'chests':               { task: 'craft',  target: 'chest',            hint: 'Craft chests from 8 planks each, place at base in organized rows.' },
  'furnaces':             { task: 'craft',  target: 'furnace',          hint: 'Craft furnaces from 8 cobblestone each. Place at base.' },
  'coal':                 { task: 'mine',   target: 'coal_ore',         hint: 'Mine coal ore (!searchForBlock coal_ore). Found in surface cliffs and shallow caves.' },
  'iron ore':             { task: 'mine',   target: 'iron_ore',         hint: 'Mine iron ore Y 15-60 (!searchForBlock iron_ore). Bring back to smelt.' },
  'iron ingots':          { task: 'smelt',  target: 'iron_ingot',       hint: 'Smelt iron_ore in furnace with coal. Use !smeltItem iron_ore.' },
  'iron pickaxes':        { task: 'craft',  target: 'iron_pickaxe',     hint: 'Craft iron pickaxes: 3 iron_ingot + 2 sticks.' },
  'iron armor pieces':    { task: 'craft',  target: 'iron_armor',       hint: 'Craft iron helmet (5), chestplate (8), leggings (7), boots (4) ingots each.' },
  'iron swords':          { task: 'craft',  target: 'iron_sword',       hint: 'Craft iron swords: 2 iron_ingot + 1 stick.' },
  'armor equipped':       { task: 'equip',  target: 'iron_armor',       hint: 'Use !equip iron_helmet, !equip iron_chestplate, etc. to wear armor.' },
  'stone for walls':      { task: 'build',  target: 'perimeter_wall',   hint: 'Mine cobblestone and build a wall 3 blocks high around the base perimeter.' },
  'torches':              { task: 'craft',  target: 'torch',            hint: 'Craft torches: 1 coal + 1 stick = 4 torches.' },
  'food for exploration': { task: 'farm',   target: 'food',             hint: 'Cook at least 32 food items before going underground.' },
  'obsidian':             { task: 'gather', target: 'obsidian',         hint: 'Find lava pool, pour water on it, mine with diamond pickaxe.' },
  'flint and steel':      { task: 'craft',  target: 'flint_and_steel',  hint: 'Craft flint_and_steel: 1 iron_ingot + 1 flint.' },
  'diamond tools':        { task: 'mine',   target: 'diamond_ore',      hint: 'Mine deep (Y -58 to -14). Use iron pickaxe to reach diamonds.' },
};

// ── Role task affinity ────────────────────────────────────────────────────
const ROLE_AFFINITY = {
  Rook:  ['gather', 'mine', 'explore'],
  Vex:   ['guard', 'combat', 'equip'],
  Drift: ['farm', 'gather', 'craft'],
  Echo:  ['smelt', 'craft', 'cook', 'gather'],
  Sage:  ['build', 'craft', 'place', 'mine'],
};

// ── Inventory aggregation ─────────────────────────────────────────────────

function aggregateInventory(agentStates) {
  const totals = {};
  for (const state of Object.values(agentStates)) {
    const counts = state?.inventory?.counts || {};
    for (const [item, count] of Object.entries(counts)) {
      totals[item] = (totals[item] || 0) + count;
    }
  }
  return totals;
}

function countMatching(inv, match) {
  if (typeof match === 'string') return inv[match] || 0;
  let total = 0;
  for (const [item, count] of Object.entries(inv)) {
    if (match.test(item)) total += count;
  }
  return total;
}

// ── checkPhase ────────────────────────────────────────────────────────────
// Returns: { phase: number, phaseName: string, phaseFocus: string, conditions: [] }

function checkPhase(agentStates) {
  const inv = aggregateInventory(agentStates);
  let resolvedPhase = 0;

  for (const phase of PHASES) {
    const allMet = phase.thresholds.every(t => countMatching(inv, t.match) >= t.count);
    if (allMet) {
      resolvedPhase = phase.id + 1;
    } else {
      break;
    }
  }

  resolvedPhase = Math.min(resolvedPhase, PHASES.length - 1);
  const phase = PHASES[resolvedPhase];

  const conditions = phase.thresholds.map(t => {
    const have = countMatching(inv, t.match);
    return { label: t.label, have, need: t.count, met: have >= t.count };
  });

  return { phase: resolvedPhase, phaseName: phase.name, phaseFocus: phase.focus, conditions };
}

// ── getBottlenecks ────────────────────────────────────────────────────────
// Returns unmet thresholds for current phase, sorted easiest-gap-first.

function getBottlenecks(phaseIndex, agentStates) {
  const phase = PHASES[phaseIndex];
  if (!phase) return [];
  const inv = aggregateInventory(agentStates);

  return phase.thresholds
    .map(t => ({
      label: t.label,
      have:  countMatching(inv, t.match),
      need:  t.count,
      gap:   Math.max(0, t.count - countMatching(inv, t.match)),
      task:  BOTTLENECK_TASKS[t.label] || { task: 'gather', target: t.label, hint: `Obtain ${t.label}` },
    }))
    .filter(b => b.gap > 0)
    .sort((a, b) => (a.gap / a.need) - (b.gap / b.need)); // closest-to-threshold first (smallest gap ratio)
}

// ── assignAgents ──────────────────────────────────────────────────────────
// Returns: { Rook: { task, target, reason, hint }, ... }

// agentStates is passed for future use (e.g. per-agent health/task checks). Not yet used.
function assignAgents(bottlenecks, agentStates, phaseIndex) {
  const agentNames = Object.keys(ROLE_AFFINITY);
  const assignments = {};

  if (bottlenecks.length === 0) {
    const phaseName = PHASES[phaseIndex]?.name || 'current phase';
    for (const name of agentNames) {
      assignments[name] = {
        task: 'prepare', target: 'next_phase',
        reason: `Phase "${phaseName}" complete — consolidating`,
        hint: 'Return to base, deposit resources in chests, prepare for next phase.',
      };
    }
    return assignments;
  }

  for (const name of agentNames) {
    // Vex always guards unless there's an explicit combat bottleneck
    if (name === 'Vex' && !bottlenecks.some(b => b.task.task === 'combat')) {
      const others = agentNames.filter(n => n !== 'Vex');
      assignments[name] = {
        task: 'guard', target: others[0] || 'base',
        reason: 'Protect gatherers and base perimeter',
        hint: `Patrol near ${others[0] || 'the base'}, attack any hostile mobs on sight.`,
      };
      continue;
    }

    const affinity = ROLE_AFFINITY[name] || ['gather'];
    const best = bottlenecks.find(b => affinity.includes(b.task.task)) || bottlenecks[0];

    assignments[name] = {
      task:   best.task.task,
      target: best.task.target,
      reason: `Need ${best.label} (have ${best.have}/${best.need})`,
      hint:   best.task.hint,
    };
  }

  return assignments;
}

// ── Exploration tracker ───────────────────────────────────────────────────

function getChunkKey(x, z) {
  return `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
}

// Update explored chunk list with current agent positions. Returns new array.
function markVisited(agentStates, exploredChunks) {
  const chunkSet = new Set(exploredChunks);
  for (const state of Object.values(agentStates)) {
    const pos = state?.gameplay?.position;
    if (pos) chunkSet.add(getChunkKey(pos.x, pos.z));
  }
  return [...chunkSet];
}

// Find nearest chunk not in exploredChunks. Returns { chunkX, chunkZ, blockX, blockZ } or null.
function getNearestUnexplored(agentPos, exploredChunks) {
  const visited = new Set(exploredChunks);
  const cx = Math.floor(agentPos.x / 16);
  const cz = Math.floor(agentPos.z / 16);

  for (let r = 1; r <= 30; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        const key = `${cx + dx},${cz + dz}`;
        if (!visited.has(key)) {
          return {
            chunkX: cx + dx,
            chunkZ: cz + dz,
            blockX: (cx + dx) * 16 + 8,
            blockZ: (cz + dz) * 16 + 8,
          };
        }
      }
    }
  }
  return null;
}

module.exports = {
  PHASES,
  checkPhase,
  getBottlenecks,
  assignAgents,
  markVisited,
  getNearestUnexplored,
  aggregateInventory,
};
