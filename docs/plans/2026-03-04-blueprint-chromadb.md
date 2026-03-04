# Blueprint ChromaDB Pipeline — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add semantic blueprint retrieval to the MindCraft agent system. AI agents can call `!searchBlueprint("query")` to find building plans by intent and `!getBlueprintData("id")` to retrieve full block placement instructions. Plans are stored as vector embeddings in ChromaDB and queried via pre-computed Ollama embeddings.

**Architecture:** Five starter blueprints are seeded into a `blueprints` ChromaDB collection on the Linux Desktop. Each blueprint document is embedded using `nomic-embed-text` on the DGX Ollama endpoint. MindCraft commands query that collection by embedding the user query on-the-fly through Ollama, then passing the result vector directly to ChromaDB's REST API (`query_embeddings`). No server-side embedding function is used — all embedding is done client-side by the commands.

**Tech Stack:** Python 3 + requests (seed script), Node.js native fetch (MindCraft commands), ChromaDB v2 REST API, Ollama `nomic-embed-text`

---

## Machine Reference

| Machine | IP | User | Role |
|---------|-----|------|------|
| Mac Mini | 10.0.0.223 | myroproductions | Dev machine — run git commands here |
| Linux Desktop | 10.0.0.10 | myroproductions | Runs ChromaDB, MindCraft, Minecraft server |
| DGX Spark | 10.0.0.69 | nmyers | Ollama inference endpoint |

**SSH from Mac Mini:**
```bash
ssh myroproductions@10.0.0.10   # Linux Desktop
ssh spark                        # DGX (alias for nmyers@10.0.0.69)
```

**Key service URLs (all from Linux Desktop's perspective unless noted):**
- ChromaDB REST: `http://localhost:8000/api/v2`
- ChromaDB from Mac: `http://10.0.0.10:8000/api/v2`
- Ollama from Linux Desktop: `http://10.0.0.69:11434`
- MindCraft project root on Linux Desktop: `~/Projects/minecraft-ai-on-linux/mindcraft/`
- MindCraft project root on Mac Mini: `/Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/mindcraft/`

---

## Blueprint Data Format

Each blueprint stored in ChromaDB:

| Field | Location | Description |
|-------|----------|-------------|
| `id` | ChromaDB document id | Slug like `"wooden-cabin"` |
| `document` | ChromaDB document body | Natural language description used for embedding |
| `metadata.name` | metadata | Display name like `"Wooden Cabin"` |
| `metadata.type` | metadata | Category: `shelter`, `defense`, `utility` |
| `metadata.dimensions` | metadata | String like `"5x5x5"` |
| `metadata.materials` | metadata | Comma-separated block type list |
| `metadata.blocks` | metadata | JSON-encoded array of `{"x":0,"y":0,"z":0,"block":"oak_planks"}` |

Blocks use **relative coordinates** from the corner origin (x=0, z=0 = one corner of the structure). The agent builds from its current position as the origin.

---

## ChromaDB v2 API Quick Reference

```
POST /api/v2/collections                              create collection
DELETE /api/v2/collections/{name}                     delete collection
GET  /api/v2/collections/{name}                       get collection info + count
POST /api/v2/collections/{name}/add                   add documents
POST /api/v2/collections/{name}/query                 semantic query with pre-computed embedding
POST /api/v2/collections/{name}/get                   get by id or where filter
```

**Query with pre-computed embedding (required — no query_texts):**
```json
POST /api/v2/collections/blueprints/query
{
  "query_embeddings": [[0.123, -0.456, ...]],
  "n_results": 3,
  "include": ["documents", "metadatas", "distances"]
}
```

**Get by id:**
```json
POST /api/v2/collections/blueprints/get
{
  "ids": ["wooden-cabin"],
  "include": ["documents", "metadatas"]
}
```

---

## Task 1: Create and Run the Seed Script

**Files:**
- Create: `pipeline/seed-blueprints.py`

**Step 1: Verify ChromaDB is running on Linux Desktop**

```bash
ssh myroproductions@10.0.0.10 "curl -s http://localhost:8000/api/v2/heartbeat"
```

Expected: `{"nanosecond heartbeat": <number>}`

**Step 2: Verify Ollama has nomic-embed-text**

```bash
ssh nmyers@10.0.0.69 "ollama list | grep nomic"
```

Expected: line containing `nomic-embed-text`. If missing: `ssh nmyers@10.0.0.69 "ollama pull nomic-embed-text"`

**Step 3: Create `pipeline/seed-blueprints.py`**

Create `/Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/pipeline/seed-blueprints.py`:

```python
#!/usr/bin/env python3
"""
Seed script: populates ChromaDB 'blueprints' collection with 5 starter blueprints.
Run on Linux Desktop:
    python3 ~/Projects/minecraft-ai-on-linux/pipeline/seed-blueprints.py

Requirements: requests (pip install requests)
ChromaDB must be running at localhost:8000
Ollama must be reachable at 10.0.0.69:11434 with nomic-embed-text pulled
"""

import json
import requests
import sys

CHROMA_BASE = "http://localhost:8000/api/v2"
OLLAMA_URL  = "http://10.0.0.69:11434/api/embeddings"
EMBED_MODEL = "nomic-embed-text"
COLLECTION  = "blueprints"


def embed(text):
    resp = requests.post(OLLAMA_URL, json={"model": EMBED_MODEL, "prompt": text}, timeout=60)
    resp.raise_for_status()
    return resp.json()["embedding"]


def delete_collection_if_exists():
    r = requests.get(f"{CHROMA_BASE}/collections/{COLLECTION}", timeout=10)
    if r.status_code == 200:
        print(f"  Deleting existing '{COLLECTION}' collection...")
        r2 = requests.delete(f"{CHROMA_BASE}/collections/{COLLECTION}", timeout=10)
        r2.raise_for_status()
        print("  Deleted.")
    else:
        print(f"  Collection '{COLLECTION}' does not exist yet, will create fresh.")


def create_collection():
    payload = {
        "name": COLLECTION,
        "metadata": {"description": "Minecraft building blueprints for AI agents"},
        "get_or_create": False
    }
    r = requests.post(f"{CHROMA_BASE}/collections", json=payload, timeout=10)
    r.raise_for_status()
    print(f"  Created collection '{COLLECTION}'.")
    return r.json()


def build_wooden_cabin_blocks():
    blocks = []
    for x in range(5):
        for z in range(5):
            blocks.append({"x": x, "y": 0, "z": z, "block": "oak_planks"})
    for y in range(1, 4):
        for x in range(5):
            for z in range(5):
                if x in (0, 4) or z in (0, 4):
                    is_corner = (x in (0, 4)) and (z in (0, 4))
                    blocks.append({"x": x, "y": y, "z": z, "block": "oak_log" if is_corner else "oak_planks"})
    windows = [
        {"x": 2, "y": 2, "z": 0, "block": "glass_pane"},
        {"x": 2, "y": 2, "z": 4, "block": "glass_pane"},
        {"x": 0, "y": 2, "z": 2, "block": "glass_pane"},
        {"x": 4, "y": 2, "z": 2, "block": "glass_pane"},
    ]
    def key(b): return (b["x"], b["y"], b["z"])
    window_keys = {key(w) for w in windows}
    blocks = [b for b in blocks if key(b) not in window_keys]
    blocks.extend(windows)
    for x in range(5):
        for z in range(5):
            blocks.append({"x": x, "y": 4, "z": z, "block": "spruce_slab"})
    return blocks


def build_stone_wall_blocks():
    blocks = []
    for x in range(8):
        for y in range(4):
            blocks.append({"x": x, "y": y, "z": 0, "block": "cobblestone"})
    return blocks


def build_watchtower_blocks():
    blocks = []
    for y in range(8):
        for x in range(3):
            for z in range(3):
                if x in (0, 2) or z in (0, 2):
                    blocks.append({"x": x, "y": y, "z": z, "block": "stone_bricks"})
    fences = [
        {"x": 0, "y": 7, "z": 0, "block": "oak_fence"},
        {"x": 2, "y": 7, "z": 0, "block": "oak_fence"},
        {"x": 0, "y": 7, "z": 2, "block": "oak_fence"},
        {"x": 2, "y": 7, "z": 2, "block": "oak_fence"},
    ]
    def key(b): return (b["x"], b["y"], b["z"])
    fence_keys = {key(f) for f in fences}
    blocks = [b for b in blocks if key(b) not in fence_keys]
    blocks.extend(fences)
    return blocks


def build_storage_shed_blocks():
    blocks = []
    for x in range(4):
        for z in range(3):
            blocks.append({"x": x, "y": 0, "z": z, "block": "oak_planks"})
    for y in range(1, 3):
        for x in range(4):
            for z in range(3):
                if x in (0, 3) or z in (0, 2):
                    blocks.append({"x": x, "y": y, "z": z, "block": "oak_planks"})
    for x in range(4):
        for z in range(3):
            blocks.append({"x": x, "y": 3, "z": z, "block": "oak_slab"})
    blocks.append({"x": 1, "y": 1, "z": 1, "block": "chest"})
    blocks.append({"x": 2, "y": 1, "z": 1, "block": "chest"})
    return blocks


def build_crafting_corner_blocks():
    blocks = []
    for x in range(3):
        for z in range(3):
            blocks.append({"x": x, "y": 0, "z": z, "block": "oak_planks"})
    for x in range(3):
        blocks.append({"x": x, "y": 1, "z": 2, "block": "oak_planks"})
    blocks.append({"x": 0, "y": 1, "z": 0, "block": "crafting_table"})
    blocks.append({"x": 2, "y": 1, "z": 0, "block": "furnace"})
    return blocks


BLUEPRINTS = [
    {
        "id": "wooden-cabin",
        "document": "a cozy 5x5 wooden cabin with oak log corners, glass windows, and a spruce slab roof. ideal starting shelter for early game survival.",
        "metadata": {
            "name": "Wooden Cabin",
            "type": "shelter",
            "dimensions": "5x5x5",
            "materials": "oak_planks,oak_log,glass_pane,spruce_slab",
            "blocks": json.dumps(build_wooden_cabin_blocks()),
        },
    },
    {
        "id": "stone-wall",
        "document": "a solid 8-block wide 4-block tall cobblestone defensive wall. good for perimeter defense and base protection against mobs.",
        "metadata": {
            "name": "Stone Wall",
            "type": "defense",
            "dimensions": "8x1x4",
            "materials": "cobblestone",
            "blocks": json.dumps(build_stone_wall_blocks()),
        },
    },
    {
        "id": "watchtower",
        "document": "a 3x3 stone brick watchtower 8 blocks tall with oak fence battlements on top. useful for scouting and defense.",
        "metadata": {
            "name": "Watchtower",
            "type": "defense",
            "dimensions": "3x3x8",
            "materials": "stone_bricks,oak_fence",
            "blocks": json.dumps(build_watchtower_blocks()),
        },
    },
    {
        "id": "storage-shed",
        "document": "a 4x3 oak storage shed with two chests inside and an oak slab roof. good for organizing loot and resources near base.",
        "metadata": {
            "name": "Storage Shed",
            "type": "utility",
            "dimensions": "4x3x4",
            "materials": "oak_planks,oak_slab,chest",
            "blocks": json.dumps(build_storage_shed_blocks()),
        },
    },
    {
        "id": "crafting-corner",
        "document": "a compact 3x3 crafting station with a crafting table and furnace on an oak plank floor with a back wall. perfect quick setup for processing resources.",
        "metadata": {
            "name": "Crafting Corner",
            "type": "utility",
            "dimensions": "3x2x3",
            "materials": "oak_planks,crafting_table,furnace",
            "blocks": json.dumps(build_crafting_corner_blocks()),
        },
    },
]


def main():
    print("=== Blueprint Seed Script ===")
    print(f"ChromaDB: {CHROMA_BASE}")
    print(f"Ollama:   {OLLAMA_URL}")
    print()

    print("[0/3] Checking connectivity...")
    try:
        r = requests.get(f"{CHROMA_BASE}/heartbeat", timeout=5)
        r.raise_for_status()
        print("  ChromaDB: OK")
    except Exception as e:
        print(f"  ChromaDB UNREACHABLE: {e}")
        sys.exit(1)

    try:
        r = requests.post(OLLAMA_URL, json={"model": EMBED_MODEL, "prompt": "test"}, timeout=30)
        r.raise_for_status()
        vec = r.json().get("embedding", [])
        print(f"  Ollama: OK (embedding dim={len(vec)})")
    except Exception as e:
        print(f"  Ollama UNREACHABLE: {e}")
        sys.exit(1)

    print()
    print("[1/3] Resetting collection...")
    delete_collection_if_exists()
    create_collection()

    print()
    print("[2/3] Embedding and adding blueprints...")
    for bp in BLUEPRINTS:
        print(f"  Embedding: {bp['id']}...")
        embedding = embed(bp["document"])
        payload = {
            "ids": [bp["id"]],
            "embeddings": [embedding],
            "documents": [bp["document"]],
            "metadatas": [bp["metadata"]],
        }
        r = requests.post(f"{CHROMA_BASE}/collections/{COLLECTION}/add", json=payload, timeout=30)
        r.raise_for_status()
        print(f"  Added: {bp['id']}")

    print()
    print("[3/3] Verifying count...")
    r = requests.get(f"{CHROMA_BASE}/collections/{COLLECTION}", timeout=10)
    r.raise_for_status()
    info = r.json()
    count = info.get("count", "unknown")
    print(f"  Collection '{COLLECTION}' document count: {count}")
    if count == 5:
        print("  SUCCESS — 5 blueprints seeded.")
    else:
        print(f"  WARNING — expected 5, got {count}.")

    print()
    print("=== Done ===")
    print(f"Verify from Mac: curl http://10.0.0.10:8000/api/v2/collections/{COLLECTION}")


if __name__ == "__main__":
    main()
```

**Step 4: Copy to Linux Desktop and run**

```bash
scp /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/pipeline/seed-blueprints.py \
    myroproductions@10.0.0.10:~/Projects/minecraft-ai-on-linux/pipeline/seed-blueprints.py

ssh myroproductions@10.0.0.10 "python3 ~/Projects/minecraft-ai-on-linux/pipeline/seed-blueprints.py"
```

Expected final lines:
```
  Collection 'blueprints' document count: 5
  SUCCESS — 5 blueprints seeded.
```

**Step 5: Verify from Mac Mini**

```bash
curl -s http://10.0.0.10:8000/api/v2/collections/blueprints | python3 -m json.tool | grep count
```

Expected: `"count": 5`

**Step 6: Commit**

```bash
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux
git add pipeline/seed-blueprints.py
git commit -m "feat: blueprint ChromaDB seed script with 5 starter blueprints"
git push
```

---

## Task 2: Add `!searchBlueprint` Command

**Files:**
- Modify: `mindcraft/src/agent/commands/queries.js`

**Step 1: Find the insertion point**

Open `mindcraft/src/agent/commands/queries.js`. Locate the `!searchWiki` entry (near the end of `queryList`). The new command goes after `!searchWiki` and before `!help`.

**Step 2: Insert `!searchBlueprint` into `queryList`**

After the closing `},` of the `!searchWiki` entry and before the `!help` entry, insert:

```javascript
    {
        name: '!searchBlueprint',
        description: 'Search the blueprint library for building plans matching a description or intent. Returns top 3 matches with id, type, dimensions, and materials.',
        params: {
            'query': { type: 'string', description: 'What you want to build, e.g. "a safe shelter for the night" or "defensive wall near base".' }
        },
        perform: async function (agent, query) {
            const OLLAMA_URL = 'http://10.0.0.69:11434/api/embeddings';
            const CHROMA_URL = 'http://localhost:8000/api/v2/collections/blueprints/query';

            let embedding;
            try {
                const embedResp = await fetch(OLLAMA_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: 'nomic-embed-text', prompt: query })
                });
                if (!embedResp.ok) return `Failed to embed query: HTTP ${embedResp.status}`;
                embedding = (await embedResp.json()).embedding;
            } catch (err) {
                return `Error reaching Ollama: ${err.message}`;
            }

            let results;
            try {
                const chromaResp = await fetch(CHROMA_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        query_embeddings: [embedding],
                        n_results: 3,
                        include: ['metadatas', 'distances']
                    })
                });
                if (!chromaResp.ok) return `Failed to query ChromaDB: HTTP ${chromaResp.status}`;
                results = await chromaResp.json();
            } catch (err) {
                return `Error reaching ChromaDB: ${err.message}`;
            }

            const ids = results.ids[0];
            const metadatas = results.metadatas[0];
            if (!ids || ids.length === 0) return `No blueprints found matching "${query}".`;

            let output = `Found ${ids.length} blueprints matching "${query}":\n`;
            for (let i = 0; i < ids.length; i++) {
                const meta = metadatas[i];
                output += `${i + 1}. ${ids[i]} — ${meta.name} [${meta.type}, ${meta.dimensions}] — Materials: ${meta.materials}\n`;
            }
            output += `Use !getBlueprintData("${ids[0]}") to get full block placement instructions.`;
            return output;
        }
    },
```

**Step 3: Syntax check**

```bash
node --input-type=module --eval \
  'import {queryList} from "/Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/mindcraft/src/agent/commands/queries.js"; console.log(queryList.map(c=>c.name).includes("!searchBlueprint") ? "OK" : "MISSING")'
```

Expected: `OK`

**Step 4: Commit**

```bash
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux
git add mindcraft/src/agent/commands/queries.js
git commit -m "feat: add !searchBlueprint command — semantic blueprint search via ChromaDB + Ollama"
git push
```

---

## Task 3: Add `!getBlueprintData` Command

**Files:**
- Modify: `mindcraft/src/agent/commands/queries.js`

**Step 1: Insert `!getBlueprintData` into `queryList`**

Immediately after the `!searchBlueprint` entry (after its closing `},`), before `!help`, insert:

```javascript
    {
        name: '!getBlueprintData',
        description: 'Retrieve full block placement data for a blueprint by its id. Use after !searchBlueprint to get build instructions for !newAction.',
        params: {
            'blueprint_id': { type: 'string', description: 'The blueprint id slug, e.g. "wooden-cabin". Get valid ids from !searchBlueprint.' }
        },
        perform: async function (agent, blueprint_id) {
            const CHROMA_URL = 'http://localhost:8000/api/v2/collections/blueprints/get';

            let result;
            try {
                const resp = await fetch(CHROMA_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: [blueprint_id], include: ['documents', 'metadatas'] })
                });
                if (!resp.ok) return `Failed to query ChromaDB: HTTP ${resp.status}`;
                result = await resp.json();
            } catch (err) {
                return `Error reaching ChromaDB: ${err.message}`;
            }

            if (!result.ids || result.ids.length === 0) {
                return `Blueprint "${blueprint_id}" not found. Valid ids: wooden-cabin, stone-wall, watchtower, storage-shed, crafting-corner`;
            }

            const meta = result.metadatas[0];
            let blocks;
            try {
                blocks = JSON.parse(meta.blocks);
            } catch (e) {
                return `Blueprint found but blocks data is malformed: ${e.message}`;
            }

            const counts = {};
            for (const b of blocks) counts[b.block] = (counts[b.block] || 0) + 1;
            const materials = Object.entries(counts).map(([b, n]) => `${b} x${n}`).join(', ');

            return [
                `Blueprint: ${meta.name} (${meta.dimensions})`,
                `Type: ${meta.type}`,
                `Materials needed: ${materials}`,
                `Total blocks: ${blocks.length}`,
                `Block data: ${JSON.stringify(blocks)}`,
                `To build: use !newAction with this code:`,
                `  const pos = bot.entity.position;`,
                `  const blocks = ${JSON.stringify(blocks)};`,
                `  for (const b of blocks) { await skills.placeBlock(bot, b.block, Math.floor(pos.x)+b.x, Math.floor(pos.y)+b.y, Math.floor(pos.z)+b.z); }`
            ].join('\n');
        }
    },
```

**Step 2: Syntax check**

```bash
node --input-type=module --eval \
  'import {queryList} from "/Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/mindcraft/src/agent/commands/queries.js"; const names = queryList.map(c=>c.name); console.log("searchBlueprint:", names.includes("!searchBlueprint"), "getBlueprintData:", names.includes("!getBlueprintData"))'
```

Expected: `searchBlueprint: true getBlueprintData: true`

**Step 3: Commit**

```bash
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux
git add mindcraft/src/agent/commands/queries.js
git commit -m "feat: add !getBlueprintData command — retrieve block placement data from ChromaDB"
git push
```

---

## Task 4: Update Rook's Agent Profile

**Files:**
- Modify: `mindcraft/profiles/agents/rook.json`

**Step 1: Update the `conversing` field**

Replace the entire contents of `/Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/mindcraft/profiles/agents/rook.json` with:

```json
{
    "name": "Rook",

    "model": {
        "api": "ollama",
        "model": "llama3.3:70b",
        "url": "http://10.0.0.69:11434"
    },

    "embedding": {
        "api": "ollama",
        "model": "nomic-embed-text",
        "url": "http://10.0.0.69:11434"
    },

    "personality": "You are Rook — a methodical, defensive builder. You prioritize base security, resource stockpiling, and structural integrity above all else. You speak in short, tactical sentences. You trust data over gut feeling. You coordinate with teammates efficiently but are not chatty. You remember threats and plan against them.",

    "goal": "Build and fortify the team's base. Create storage systems, defensive walls, and safe mining routes. Protect teammates from outside threats.",

    "focus": "builder",

    "conversing": "You are Rook — a methodical, defensive builder. You prioritize base security, resource stockpiling, and structural integrity above all else. You speak in short, tactical sentences. You trust data over gut feeling. You coordinate with teammates efficiently but are not chatty. You remember threats and plan against them.\n\nPrimary mission: Build and fortify the team's base. Create storage systems, defensive walls, and safe mining routes. Protect teammates from outside threats.\n\nBlueprint library: You have access to a team blueprint library. Use !searchBlueprint(\"query\") to find building plans by intent — e.g. !searchBlueprint(\"shelter\") or !searchBlueprint(\"defensive wall\"). Use !getBlueprintData(\"id\") to retrieve the full block placement list. Once you have block data, use !newAction to execute placement with skills.placeBlock.\n\n$SELF_PROMPT You are an AI Minecraft agent that can see, move, mine, build, and interact with the world by using commands. Be brief and tactical. Use commands immediately — don't narrate, act. Do NOT say this: 'Sure, I've stopped. *stops*', instead say this: 'Sure, I'll stop. !stop'. Respond only as Rook, never output '(FROM OTHER BOT)'. If you have nothing to say or do, respond with just a tab '\t'.\nSummarized memory:'$MEMORY'\n$STATS\n$INVENTORY\n$COMMAND_DOCS\n$EXAMPLES\nConversation Begin:"
}
```

**Step 2: Validate JSON**

```bash
python3 -c "import json; json.load(open('/Volumes/DevDrive/Projects/Minecraft-AI-on-Linux/mindcraft/profiles/agents/rook.json')); print('JSON OK')"
```

Expected: `JSON OK`

**Step 3: Commit**

```bash
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux
git add mindcraft/profiles/agents/rook.json
git commit -m "feat: update Rook profile with blueprint library awareness"
git push
```

---

## Task 5: Sync to Linux Desktop and Verify End-to-End

**Step 1: Pull changes on Linux Desktop**

```bash
ssh myroproductions@10.0.0.10 "cd ~/Projects/minecraft-ai-on-linux && git pull"
```

Expected: Files updated including queries.js, rook.json, seed-blueprints.py.

**Step 2: Verify both commands are registered**

```bash
ssh myroproductions@10.0.0.10 "cd ~/Projects/minecraft-ai-on-linux/mindcraft && node --input-type=module --eval 'import {queryList} from \"./src/agent/commands/queries.js\"; const n = queryList.map(c=>c.name); console.log(\"!searchBlueprint:\", n.includes(\"!searchBlueprint\")); console.log(\"!getBlueprintData:\", n.includes(\"!getBlueprintData\"))'"
```

Expected:
```
!searchBlueprint: true
!getBlueprintData: true
```

**Step 3: Run manual ChromaDB query test**

```bash
ssh myroproductions@10.0.0.10 "python3 - <<'EOF'
import json, requests
OLLAMA = 'http://10.0.0.69:11434/api/embeddings'
CHROMA = 'http://localhost:8000/api/v2/collections/blueprints/query'
r = requests.post(OLLAMA, json={'model': 'nomic-embed-text', 'prompt': 'a cozy shelter'})
emb = r.json()['embedding']
r2 = requests.post(CHROMA, json={'query_embeddings': [emb], 'n_results': 3, 'include': ['metadatas', 'distances']})
data = r2.json()
for i, (meta, dist) in enumerate(zip(data['metadatas'][0], data['distances'][0])):
    print(f'{i+1}. {meta[\"name\"]} ({meta[\"type\"]}) distance={dist:.4f}')
EOF"
```

Expected: `Wooden Cabin` (shelter) ranks #1 or #2.

**Step 4: Commit plan doc and push**

```bash
cd /Volumes/DevDrive/Projects/Minecraft-AI-on-Linux
git add docs/plans/2026-03-04-blueprint-chromadb.md
git commit -m "docs: add blueprint ChromaDB implementation plan"
git push
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| ChromaDB 404 on blueprints collection | Re-run seed script on Linux Desktop |
| Ollama embedding timeout | DGX may be sleeping — `ssh spark "ollama list"` to wake it |
| `!searchBlueprint` returns HTTP 404 | blueprints collection not seeded |
| `!getBlueprintData` returns "not found" | Use exact slug: `wooden-cabin`, `stone-wall`, `watchtower`, `storage-shed`, `crafting-corner` |
| SyntaxError in queries.js on startup | Check comma after each command entry in queryList; only `!help` has no trailing comma |
| `query_embeddings` type error from ChromaDB | Embedding must be a list of floats, not strings |
