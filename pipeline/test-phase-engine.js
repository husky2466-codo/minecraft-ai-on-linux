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

test('bottlenecks sorted by gap ratio ascending (closest-to-threshold first)', () => {
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
