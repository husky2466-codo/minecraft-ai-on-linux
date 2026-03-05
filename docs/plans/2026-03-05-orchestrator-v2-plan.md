# Nexus Orchestrator v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Replace the vibe-based orchestrator with a phase engine that enforces a 10-phase survival ladder using hard inventory thresholds, dynamic bottleneck-driven agent assignment, and coordinate-based exploration tracking.

**Architecture:** A new `nexus-phase-engine.js` module does all structural decisions in pure code (phase check, bottleneck detection, agent assignment, exploration tracking). The orchestrator calls it each tick and feeds the structured brief to the LLM, which only translates assignments into natural language directives. The LLM stops making structural decisions.

**Tech Stack:** Node.js 22, `nexus-orchestrator.js` (existing), `nexus-phase-engine.js` (new), `nexus-task-state.json` (schema extended)

**Project root (Mac dev):** `/Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/`
**Project root (Linux):** `~/Projects/minecraft-ai-on-linux/`
**Branch:** `dev`

**Key data shape — agentStates (from MindServer socket):**
```js
{
  Rook: {
    inventory: { counts: { oak_log: 5, stone_pickaxe: 1 } },
    gameplay:  { position: { x: 10, y: 64, z: -5 }, health: 20, food: 18 },
    task: 'mining stone'
  },
  // Vex, Drift, Echo, Sage same shape
}
```

---

## Task 1: Create nexus-phase-engine.js — PHASES + inventory aggregation + checkPhase

**Files:**
- Create: `pipeline/nexus-phase-engine.js`

**Step 1: Create the file with PHASES array and inventory helpers**

Create `/Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/pipeline/nexus-phase-engine.js`:

```js
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

  const conditions = phase.thresholds.map(t => ({
    label: t.label,
    have:  countMatching(inv, t.match),
    need:  t.count,
    met:   countMatching(inv, t.match) >= t.count,
  }));

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
    .sort((a, b) => (a.gap / a.need) - (b.gap / b.need));
}

// ── assignAgents ──────────────────────────────────────────────────────────
// Returns: { Rook: { task, target, reason, hint }, ... }

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
```

**Step 2: Verify it loads without errors**

```bash
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/pipeline
node -e "const e = require('./nexus-phase-engine'); console.log('PHASES:', e.PHASES.length, 'exports:', Object.keys(e).join(', '))"
```

Expected output:
```
PHASES: 10 exports: PHASES, checkPhase, getBottlenecks, assignAgents, markVisited, getNearestUnexplored, aggregateInventory
```

**Step 3: Commit**

```bash
git add pipeline/nexus-phase-engine.js
git commit -m "feat(nexus): add phase engine — 10-phase survival ladder with inventory thresholds"
```

---

## Task 2: Write and run unit tests for phase engine

**Files:**
- Create: `pipeline/test-phase-engine.js`

**Step 1: Create test file**

Create `/Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/pipeline/test-phase-engine.js`:

```js
'use strict';
const { strict: assert } = require('assert');
const {
  checkPhase, getBottlenecks, assignAgents,
  markVisited, getNearestUnexplored, aggregateInventory,
} = require('./nexus-phase-engine');

// Helper: build mock agentStates from inventory object
function mockStates(inventories) {
  return Object.fromEntries(
    Object.entries(inventories).map(([name, counts]) => [
      name,
      {
        inventory: { counts },
        gameplay: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20 },
        task: 'idle',
      },
    ])
  );
}

let passed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`✗ ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// ── aggregateInventory ────────────────────────────────────────────────────
test('aggregates inventory across all agents', () => {
  const states = mockStates({
    Rook: { oak_log: 10 },
    Echo: { oak_log: 5, coal: 3 },
  });
  const inv = aggregateInventory(states);
  assert.equal(inv.oak_log, 15);
  assert.equal(inv.coal, 3);
});

// ── checkPhase ────────────────────────────────────────────────────────────
test('empty inventory → phase 0 (Shelter)', () => {
  const states = mockStates({ Rook: {}, Vex: {}, Drift: {}, Echo: {}, Sage: {} });
  const { phase, phaseName } = checkPhase(states);
  assert.equal(phase, 0);
  assert.equal(phaseName, 'Shelter');
});

test('shelter items met → phase 1 (Basic Tools)', () => {
  const states = mockStates({
    Rook: { oak_planks: 64, crafting_table: 1, white_bed: 4 },
    Vex: {}, Drift: {}, Echo: {}, Sage: {},
  });
  const { phase, phaseName } = checkPhase(states);
  assert.equal(phase, 1);
  assert.equal(phaseName, 'Basic Tools');
});

test('regex threshold matches any plank type', () => {
  const states = mockStates({
    Rook: { spruce_planks: 30, birch_planks: 34, crafting_table: 1, red_bed: 4 },
    Vex: {}, Drift: {}, Echo: {}, Sage: {},
  });
  const { phase } = checkPhase(states);
  assert.equal(phase, 1, 'mixed plank types should still satisfy shelter threshold');
});

test('partial progress stays at phase 0', () => {
  const states = mockStates({
    Rook: { oak_planks: 40, crafting_table: 1 }, // beds missing
    Vex: {}, Drift: {}, Echo: {}, Sage: {},
  });
  const { phase } = checkPhase(states);
  assert.equal(phase, 0);
});

// ── getBottlenecks ────────────────────────────────────────────────────────
test('returns unmet thresholds for current phase', () => {
  const states = mockStates({
    Rook: { oak_planks: 40, crafting_table: 1 }, // beds missing, planks short
    Vex: {}, Drift: {}, Echo: {}, Sage: {},
  });
  const bn = getBottlenecks(0, states);
  assert(bn.length >= 1, 'should have bottlenecks');
  assert(bn.every(b => b.gap > 0), 'all returned bottlenecks should have gap > 0');
});

test('returns empty array when phase fully met', () => {
  const states = mockStates({
    Rook: { oak_planks: 64, crafting_table: 1, white_bed: 4 },
    Vex: {}, Drift: {}, Echo: {}, Sage: {},
  });
  const bn = getBottlenecks(0, states);
  assert.equal(bn.length, 0, 'no bottlenecks when all thresholds met');
});

test('bottlenecks sorted by gap ratio (smallest first)', () => {
  const states = mockStates({ Rook: { oak_planks: 60 }, Vex: {}, Drift: {}, Echo: {}, Sage: {} });
  const bn = getBottlenecks(0, states);
  // planks gap = 4/64 = 6%, beds gap = 4/4 = 100% — planks should come first
  assert(bn[0].label === 'wood planks', `expected planks first, got ${bn[0].label}`);
});

// ── assignAgents ──────────────────────────────────────────────────────────
test('Vex always gets guard assignment when no combat bottleneck', () => {
  const states = mockStates({ Rook: {}, Vex: {}, Drift: {}, Echo: {}, Sage: {} });
  const bn = getBottlenecks(0, states);
  const assignments = assignAgents(bn, states, 0);
  assert.equal(assignments.Vex.task, 'guard', 'Vex should always guard');
});

test('all 5 agents get assignments', () => {
  const states = mockStates({ Rook: {}, Vex: {}, Drift: {}, Echo: {}, Sage: {} });
  const bn = getBottlenecks(0, states);
  const assignments = assignAgents(bn, states, 0);
  assert.equal(Object.keys(assignments).length, 5, 'all 5 agents assigned');
});

test('when no bottlenecks, all agents get prepare task', () => {
  const states = mockStates({
    Rook: { oak_planks: 64, crafting_table: 1, white_bed: 4 },
    Vex: {}, Drift: {}, Echo: {}, Sage: {},
  });
  const assignments = assignAgents([], states, 0);
  assert(Object.values(assignments).every(a => a.task === 'prepare'), 'all should prepare');
});

// ── Exploration tracker ───────────────────────────────────────────────────
test('markVisited adds correct chunk key for agent position', () => {
  const states = mockStates({ Rook: {} });
  states.Rook.gameplay.position = { x: 20, y: 64, z: 35 };
  // chunk: floor(20/16)=1, floor(35/16)=2 → key "1,2"
  const explored = markVisited(states, []);
  assert(explored.includes('1,2'), `expected "1,2", got: ${explored}`);
});

test('markVisited does not duplicate chunks', () => {
  const states = mockStates({ Rook: {} });
  states.Rook.gameplay.position = { x: 8, y: 64, z: 8 };
  const explored = markVisited(states, ['0,0']);
  assert.equal(explored.filter(k => k === '0,0').length, 1, 'should not duplicate');
});

test('getNearestUnexplored returns adjacent chunk', () => {
  const explored = ['0,0'];
  const result = getNearestUnexplored({ x: 8, y: 64, z: 8 }, explored);
  assert(result !== null, 'should find unexplored chunk');
  const key = `${result.chunkX},${result.chunkZ}`;
  assert(!explored.includes(key), 'should not return visited chunk');
});

test('getNearestUnexplored returns null when all chunks explored (small grid)', () => {
  // Fill a 61x61 chunk grid centered on 0,0 (max search radius is 30)
  const explored = [];
  for (let x = -30; x <= 30; x++) {
    for (let z = -30; z <= 30; z++) {
      explored.push(`${x},${z}`);
    }
  }
  const result = getNearestUnexplored({ x: 0, y: 64, z: 0 }, explored);
  assert.equal(result, null, 'should return null when all nearby chunks explored');
});

console.log(`\n${passed} tests passed`);
```

**Step 2: Run tests**

```bash
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/pipeline
node test-phase-engine.js
```

Expected output:
```
✓ aggregates inventory across all agents
✓ empty inventory → phase 0 (Shelter)
✓ shelter items met → phase 1 (Basic Tools)
✓ regex threshold matches any plank type
✓ partial progress stays at phase 0
✓ returns unmet thresholds for current phase
✓ returns empty array when phase fully met
✓ bottlenecks sorted by gap ratio (smallest first)
✓ Vex always gets guard assignment when no combat bottleneck
✓ all 5 agents get assignments
✓ when no bottlenecks, all agents get prepare task
✓ markVisited adds correct chunk key for agent position
✓ markVisited does not duplicate chunks
✓ getNearestUnexplored returns adjacent chunk
✓ getNearestUnexplored returns null when all chunks explored (small grid)

15 tests passed
```

**Step 3: Commit**

```bash
git add pipeline/test-phase-engine.js
git commit -m "test(nexus): unit tests for phase engine — 15 passing"
```

---

## Task 3: Wire phase engine into orchestrator — state schema + loop integration

**Files:**
- Modify: `pipeline/nexus-orchestrator.js`

**Step 1: Add the require at the top of nexus-orchestrator.js**

After the existing `require` block (after line 9, before the `// ── Config` comment), add:

```js
const {
  checkPhase,
  getBottlenecks,
  assignAgents,
  markVisited,
  getNearestUnexplored,
} = require('./nexus-phase-engine');
```

**Step 2: Update readTaskState() to return new schema with defaults**

Replace the existing `readTaskState` function (lines 63-66):

```js
function readTaskState() {
  try {
    const raw = JSON.parse(fs.readFileSync(TASK_STATE_FILE, 'utf8'));
    // Ensure all new fields have defaults for backwards compatibility
    return {
      phase:          raw.phase          ?? 0,
      phaseStartedAt: raw.phaseStartedAt ?? new Date().toISOString(),
      goals:          raw.goals          ?? {},
      lastDirectives: raw.lastDirectives ?? {},
      exploredChunks: raw.exploredChunks ?? [],
      milestones:     raw.milestones     ?? [],
    };
  } catch (_) {
    return {
      phase: 0, phaseStartedAt: new Date().toISOString(),
      goals: {}, lastDirectives: {},
      exploredChunks: [], milestones: [],
    };
  }
}
```

**Step 3: Update runLoop() to call the phase engine**

In `runLoop()`, find the block starting with `// Load persistent task state` (around line 592). Replace the entire task state section through the `getDirectives` call:

```js
    // Load persistent task state
    const taskState = readTaskState();

    // ── Phase engine ──────────────────────────────────────────────────────
    // 1. Check current phase against live inventory
    const { phase, phaseName, phaseFocus, conditions } = checkPhase(agentStates);

    // 2. Detect phase advancement and log milestones
    if (phase > taskState.phase) {
      const prevName = PHASES_FOR_LOG[taskState.phase] || `Phase ${taskState.phase}`;
      log(`[Phase] *** MILESTONE: "${prevName}" complete → advancing to Phase ${phase} (${phaseName}) ***`);
      taskState.milestones.push({
        phase:       taskState.phase,
        name:        prevName,
        completedAt: new Date().toISOString(),
      });
      taskState.phaseStartedAt = new Date().toISOString();
    }

    // 3. Emergency regression: if Phase 8+ and armor count drops < 10, regress to Phase 6
    const armorCount = conditions.find(c => c.label === 'armor equipped')?.have ?? null;
    if (phase >= 8 && armorCount !== null && armorCount < 10) {
      log(`[Phase] EMERGENCY: armor count ${armorCount} < 10 — regressing to Phase 6 (Armor and Weapons)`);
      taskState.phase = 6;
    } else {
      taskState.phase = phase;
    }

    // 4. Get bottlenecks and assignments from phase engine
    const bottlenecks = getBottlenecks(taskState.phase, agentStates);
    const assignments = assignAgents(bottlenecks, agentStates, taskState.phase);

    // 5. Update exploration tracker from current agent positions
    taskState.exploredChunks = markVisited(agentStates, taskState.exploredChunks);

    log(`[Phase] ${phaseName} (${taskState.phase}/9) | bottlenecks: ${bottlenecks.map(b => `${b.label} ${b.have}/${b.need}`).join(', ') || 'none'}`);
    log(`[Phase] Assignments: ${Object.entries(assignments).map(([n, a]) => `${n}=${a.task}:${a.target}`).join(', ')}`);

    const { directives, updatedGoals } = await getDirectives(visual, recentLogs, agentMemories, taskState, { phaseName, phaseFocus, bottlenecks, assignments });

    // Persist updated state
    const lastDirectives = {};
    directives.forEach(d => { lastDirectives[d.agent] = d.message; });
    writeTaskState({
      ...taskState,
      goals:          { ...taskState.goals, ...updatedGoals },
      lastDirectives: { ...taskState.lastDirectives, ...lastDirectives },
    });
```

**Step 4: Add PHASES_FOR_LOG constant near the top of the file (after AGENT_ROLES)**

```js
// Phase name lookup for milestone logging (mirrors nexus-phase-engine PHASES order)
const PHASES_FOR_LOG = [
  'Shelter', 'Basic Tools', 'Food Secured', 'Storage System', 'Iron Gathering',
  'Iron Age', 'Armor and Weapons', 'Surface Secured', 'Cave Exploration', 'Nether Prep',
];
```

**Step 5: Commit**

```bash
git add pipeline/nexus-orchestrator.js
git commit -m "feat(nexus): wire phase engine into orchestrator loop — phase tracking, milestones, emergency regression"
```

---

## Task 4: Update getDirectives() to accept phase brief and generate constrained directives

**Files:**
- Modify: `pipeline/nexus-orchestrator.js` (getDirectives function)

**Step 1: Update getDirectives signature and system prompt**

Replace the entire `getDirectives` function with:

```js
async function getDirectives(visualDescription, recentLogs, agentMemories = '', taskState = {}, phaseBrief = {}) {
  const agentCtx = buildAgentContext();
  const { phaseName = 'Unknown', phaseFocus = '', bottlenecks = [], assignments = {} } = phaseBrief;

  // Build assignment block for LLM
  const assignmentBlock = Object.entries(assignments).map(([name, a]) => {
    return `  ${name}: ${a.task.toUpperCase()} → ${a.target} | ${a.hint}`;
  }).join('\n');

  // Build bottleneck status for LLM context
  const bottleneckBlock = bottlenecks.length > 0
    ? bottlenecks.map(b => `  ${b.label}: have ${b.have}, need ${b.need} (gap: ${b.gap})`).join('\n')
    : '  All phase thresholds met — consolidate and prepare for next phase.';

  const systemPrompt = `You are Nexus — the AI foreman for a 5-agent Minecraft survival team.

The phase engine has already decided what each agent does this tick. Your ONLY job is to write each agent's directive as a natural, specific command using their assigned task. Do NOT change assignments. Do NOT assign different tasks. Translate assignments into directives.

DIRECTIVE RULES:
- Each directive must be ≤25 words
- Include at least one MindCraft command (!searchForBlock, !craftRecipe, !smeltItem, !tillAndSow, !equip, !attack, !goToCoordinates, etc.)
- Sound like a foreman giving a direct work order
- Reference the specific target item or action from the assignment
- Vex always guards — her directive should name who she's protecting or where to patrol

Output EXACTLY this format (no extra text):
GOALS:
Rook: [one-sentence goal for this phase, carry forward if unchanged]
Vex: [goal]
Drift: [goal]
Echo: [goal]
Sage: [goal]

DIRECTIVES:
Rook: [directive with MindCraft command]
Vex: [directive with MindCraft command]
Drift: [directive with MindCraft command]
Echo: [directive with MindCraft command]
Sage: [directive with MindCraft command]`;

  const memSection = agentMemories ? `\nAGENT MEMORIES:\n${agentMemories}\n` : '';

  const userPrompt = `CURRENT PHASE: ${taskState.phase}/9 — ${phaseName}
PHASE FOCUS: ${phaseFocus}

BOTTLENECK STATUS (what's blocking phase completion):
${bottleneckBlock}

AGENT ASSIGNMENTS (from phase engine — do not change):
${assignmentBlock}

VISUAL SNAPSHOT:
${visualDescription}
${memSection}
AGENT STATES:
${agentCtx}

RECENT LOG (last 50 lines):
${recentLogs.slice(-2000)}

Write GOALS then DIRECTIVES now.`;

  try {
    const res = await ollamaPost('/api/chat', {
      model: REASON_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      stream: false,
      options: { num_predict: 500 },
    });
    const raw = res.message?.content?.trim() || '';
    log(`[Reason] Response:\n${raw}`);
    return parseOrchResponse(raw);
  } catch (e) {
    log(`[Reason] Error: ${e.message}`);
    return { directives: [], updatedGoals: {} };
  }
}
```

**Step 2: Verify the file loads without errors**

```bash
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/pipeline
node -e "require('./nexus-orchestrator.js')" 2>&1 | head -5
```

Expected: no errors (process will hang waiting for MC connection — Ctrl+C after 2s is fine).

**Step 3: Commit**

```bash
git add pipeline/nexus-orchestrator.js
git commit -m "feat(nexus): phase-aware LLM prompt — engine assigns, LLM translates to directives"
```

---

## Task 5: Push, deploy to Linux, smoke test

**Files:** none (deploy only)

**Step 1: Push to GitHub**

```bash
git push origin dev
```

**Step 2: Pull on Linux and restart orchestrator**

```bash
ssh myroproductions@10.0.0.10 "cd ~/Projects/minecraft-ai-on-linux && git pull origin dev && echo PULLED"
ssh myroproductions@10.0.0.10 "fuser -k 3099/tcp; pkill -f nexus-orchestrator.js; sleep 1 && echo KILLED"
ssh myroproductions@10.0.0.10 "cd ~/Projects/minecraft-ai-on-linux/pipeline && SSH_KEY_PATH=/home/myroproductions/.ssh/id_ed25519 nohup node nexus-orchestrator.js >> ~/nexus-orchestrator.log 2>&1 & echo STARTED"
```

**Step 3: Watch the log for phase engine output**

```bash
ssh myroproductions@10.0.0.10 "sleep 15 && tail -30 ~/nexus-orchestrator.log"
```

Expected to see lines like:
```
[Phase] Shelter (0/9) | bottlenecks: wood planks 0/64, crafting table 0/1, beds 0/4
[Phase] Assignments: Rook=gather:oak_log, Vex=guard:Rook, Drift=farm:crops, Echo=craft:crafting_table, Sage=build:perimeter_wall
[Reason] Response:
GOALS:
Rook: Gather 64 oak planks for shelter phase...
...
DIRECTIVES:
Rook: !searchForBlock oak_log 64 — chop trees and gather logs for planks...
```

**Step 4: Verify phase state is saved**

```bash
ssh myroproductions@10.0.0.10 "cat ~/nexus-task-state.json"
```

Expected: JSON with `phase`, `exploredChunks`, `milestones` fields present.

**Step 5: Commit any fixes found during smoke test, then final push**

```bash
git add -p  # stage only intentional fixes
git commit -m "fix(nexus): smoke test fixes"
git push origin dev
```
