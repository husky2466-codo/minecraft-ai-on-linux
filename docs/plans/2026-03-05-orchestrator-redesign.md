# Nexus Orchestrator v2 — Design Doc

**Date:** 2026-03-05
**Status:** Approved

---

## Goal

Transform the Nexus orchestrator from a "vibes-based directive loop" into a structured survival-first project manager that thinks like a human foreman: knows what phase the team is in, checks hard inventory thresholds to advance phases, dynamically assigns whoever can unblock the current bottleneck, and systematically explores underground using coordinate tracking.

---

## Architecture

```
nexus-orchestrator.js         (main loop — unchanged structure)
    │
    ├── nexus-phase-engine.js  (NEW — all structural decisions in pure code)
    │       ├── PHASES[]       phase ladder with thresholds
    │       ├── checkPhase()   aggregate inventory → current phase
    │       ├── getBottlenecks() what's blocking phase advancement
    │       ├── assignAgents() dynamic bottleneck → agent assignments
    │       └── explorationTracker  coordinate grid of visited chunks
    │
    └── nexus-task-state.json  (extended schema)
            ├── phase          current phase index (0-9)
            ├── phaseStartedAt ISO timestamp
            ├── goals{}        per-agent goal strings (existing)
            ├── lastDirectives{} (existing)
            ├── exploredChunks[] array of "x,z" chunk keys
            └── milestones[]   log of completed phases with timestamps
```

The orchestrator calls the phase engine each tick to get a structured brief. The LLM receives that brief and translates it into natural language directives. The LLM no longer makes structural decisions — the code does.

---

## Phase Ladder (10 phases)

All thresholds are checked against the **combined inventory of all 5 agents**.
Phase advances automatically when ALL conditions for that phase pass.
Emergency regression: if Phase 8 is active and armor count drops below 10, regress to Phase 7.

| # | Name | Unlock Conditions |
|---|------|-------------------|
| 0 | **Shelter** | planks≥64, crafting_table placed, beds≥4 |
| 1 | **Basic Tools** | stone_pickaxe≥5, stone_axe≥5, stone_shovel≥5 |
| 2 | **Food Secured** | cooked_food≥64, crops_planted≥16, animals_penned≥4 |
| 3 | **Storage System** | chests_placed≥9, furnaces_placed≥3, coal≥32 |
| 4 | **Iron Gathering** | iron_ore≥32 |
| 5 | **Iron Age** | iron_ingot≥32, iron tools for 5 agents |
| 6 | **Armor & Weapons** | iron_armor_pieces≥20, iron_sword≥5 |
| 7 | **Surface Secured** | armor_equipped≥5, stone_placed≥32 (perimeter wall) |
| 8 | **Cave Exploration** | torches≥64, exploration tracker active |
| 9 | **Deep / Nether Prep** | obsidian≥10, flint_and_steel≥1, diamond_tools≥2 |

---

## Phase Engine (`nexus-phase-engine.js`)

### `checkPhase(agentStates) → { phase, conditions }`

Aggregates inventory counts across all 5 agents. Checks each phase's
threshold array in order. Returns the highest phase where all conditions pass.
Also returns which conditions are failing (for bottleneck detection).

```js
// Threshold format
{ item: 'iron_ingot', count: 32, source: 'inventory' }
{ item: 'furnace', count: 3,  source: 'placed' }   // placed = RCON scoreboard or log-detected
```

### `getBottlenecks(phase, agentStates) → bottleneck[]`

For the current phase, returns which threshold conditions are not yet met,
sorted by how far they are from completion (closest first — attack the
easiest win to unblock fast).

```js
// Example output
[
  { item: 'beds', have: 1, need: 4, gap: 3 },
  { item: 'planks', have: 40, need: 64, gap: 24 }
]
```

### `assignAgents(bottlenecks, agentStates, agentRoles) → assignments{}`

Maps each agent to the highest-priority bottleneck they can address given
their role and current state. Roles are suggestions — any agent can do any
task if they're available and others are busy.

```js
// Example output
{
  Rook:  { task: 'gather', target: 'oak_log', reason: 'need planks for shelter' },
  Echo:  { task: 'craft',  target: 'bed',     reason: 'need 3 more beds' },
  Sage:  { task: 'place',  target: 'crafting_table', reason: 'shelter threshold' },
  Drift: { task: 'find',   target: 'animals', reason: 'food phase prep' },
  Vex:   { task: 'guard',  target: 'perimeter', reason: 'protect gatherers' }
}
```

### Exploration Tracker

Tracks visited chunks as `"x,z"` chunk keys (block coords / 16, floored).
Updated each tick from agent positions in agentStates.

```js
function markVisited(agentStates, exploredChunks)
function getNearestUnexplored(agentPos, exploredChunks, depthTier) → { x, z }
// depthTier: 'surface' (Y>50), 'mid' (Y 20-50), 'deep' (Y<20)
// Only mid/deep unlocked after Phase 8
```

---

## Extended State Schema (`nexus-task-state.json`)

```json
{
  "phase": 2,
  "phaseStartedAt": "2026-03-05T07:00:00.000Z",
  "goals": {
    "Rook": "Gather oak logs to hit 64 planks for shelter phase",
    "Vex": "Guard Rook while gathering — eliminate any hostile mobs nearby"
  },
  "lastDirectives": {},
  "exploredChunks": ["0,0", "1,0", "0,1", "-1,0"],
  "milestones": [
    { "phase": 0, "name": "Shelter", "completedAt": "2026-03-05T07:12:00.000Z" },
    { "phase": 1, "name": "Basic Tools", "completedAt": "2026-03-05T07:34:00.000Z" }
  ]
}
```

---

## Updated Orchestrator Loop

Each tick:

1. Orbit + screenshot + vision description (unchanged)
2. Read agent states from MindServer (unchanged)
3. **Call `checkPhase(agentStates)`** — get current phase + failing conditions
4. **Call `getBottlenecks(phase, agentStates)`** — sorted list of what's blocking
5. **Call `assignAgents(bottlenecks, agentStates)`** — structured assignments
6. **Update exploration tracker** — mark agent positions as visited chunks
7. **Check for phase advance** — if phase changed, log milestone + update state
8. **Build LLM brief** — pass phase name, bottlenecks, assignments, visual description, recent logs
9. **LLM generates directives** — natural language only, constrained to the assignments
10. Send directives (unchanged)

### LLM Prompt Change

The system prompt changes from "you decide what each agent does" to:

> "You are Nexus. The phase engine has already decided what each agent should do this tick.
> Your job: write a natural language directive for each agent that matches their assignment,
> sounds like a real foreman, and uses the correct MindCraft commands.
> Do NOT change assignments. Translate them into directives."

---

## Files Changed

| File | Change |
|------|--------|
| `pipeline/nexus-phase-engine.js` | **NEW** — phase ladder, bottleneck detection, agent assignment, exploration tracker |
| `pipeline/nexus-orchestrator.js` | **MODIFY** — import phase engine, call it each tick, update LLM prompt, extend state r/w |
| `pipeline/nexus-task-state.json` | **SCHEMA CHANGE** — add phase, exploredChunks, milestones |

---

## Agent Profile Updates

Add phase-awareness to all 5 agent `init_message` and `conversing` prompts:
agents should respond to directives that reference specific items/coordinates
without questioning them — they trust Nexus has a reason.

---

## Success Criteria

- Phase advances automatically when inventory thresholds are met (no LLM judgment needed)
- Agents are never assigned tasks that don't advance the current phase
- Underground exploration only starts after Phase 8 (surface secured)
- Explored chunks are tracked and agents are always sent to new territory
- Milestone log in state file shows completed phases with timestamps
- Emergency regression triggers if armor drops below threshold during Phase 8+
