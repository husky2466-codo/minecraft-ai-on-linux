#!/usr/bin/env python3
"""
Seed script: populates ChromaDB 'blueprints' collection with 5 starter blueprints.
Run on Linux Desktop:
    python3 ~/Projects/minecraft-ai-on-linux/pipeline/seed-blueprints.py

Requirements: chromadb requests (pip install chromadb requests)
ChromaDB must be running at localhost:8000
Ollama must be reachable at 10.0.0.69:11434 with nomic-embed-text pulled
"""

import json
import sys

import requests

CHROMA_HOST = "localhost"
CHROMA_PORT = 8000
OLLAMA_URL  = "http://10.0.0.69:11434/api/embeddings"
EMBED_MODEL = "nomic-embed-text"
COLLECTION  = "blueprints"


def embed(text):
    resp = requests.post(OLLAMA_URL, json={"model": EMBED_MODEL, "prompt": text}, timeout=60)
    resp.raise_for_status()
    return resp.json()["embedding"]


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
    print(f"ChromaDB: http://{CHROMA_HOST}:{CHROMA_PORT}")
    print(f"Ollama:   {OLLAMA_URL}")
    print()

    print("[0/3] Checking connectivity...")
    try:
        import chromadb
        client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)
        client.heartbeat()
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
    existing = [c.name for c in client.list_collections()]
    if COLLECTION in existing:
        print(f"  Deleting existing '{COLLECTION}' collection...")
        client.delete_collection(COLLECTION)
        print("  Deleted.")
    else:
        print(f"  Collection '{COLLECTION}' does not exist yet, will create fresh.")
    col = client.create_collection(
        name=COLLECTION,
        metadata={"description": "Minecraft building blueprints for AI agents"},
    )
    print(f"  Created collection '{COLLECTION}'.")

    print()
    print("[2/3] Embedding and adding blueprints...")
    for bp in BLUEPRINTS:
        print(f"  Embedding: {bp['id']}...")
        embedding = embed(bp["document"])
        col.add(
            ids=[bp["id"]],
            embeddings=[embedding],
            documents=[bp["document"]],
            metadatas=[bp["metadata"]],
        )
        print(f"  Added: {bp['id']}")

    print()
    print("[3/3] Verifying count...")
    count = col.count()
    print(f"  Collection '{COLLECTION}' document count: {count}")
    if count == 5:
        print("  SUCCESS — 5 blueprints seeded.")
    else:
        print(f"  WARNING — expected 5, got {count}.")

    print()
    print("=== Done ===")
    print(f"Verify from Mac: curl http://10.0.0.10:8000/api/v2/tenants/default_tenant/databases/default_database/collections/{COLLECTION}")


if __name__ == "__main__":
    main()
