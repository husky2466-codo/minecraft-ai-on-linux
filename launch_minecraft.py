#!/usr/bin/env python3
"""
Minecraft AI Session Launcher

Launches the full Minecraft AI stack on the Linux Desktop (10.0.0.10):
  1. ChromaDB (vector memory store)
  2. Minecraft Java Server
  3. Ollama queue proxy
  4. MindCraft AI agents
  5. Nexus orchestrator

Resumes any existing session state from ~/nexus-task-state.json automatically.

Usage:
    python3 launch_minecraft.py              # Start full stack
    python3 launch_minecraft.py --stop       # Stop all services
    python3 launch_minecraft.py --status     # Check service status
"""

import argparse
import subprocess
import sys
import time

DESKTOP = "myroproductions@10.0.0.10"
NODE_PATH = "$HOME/.nvm/versions/node/v22.22.0/bin:$HOME/.local/bin:$PATH"
PROJECT_DIR = "~/Projects/minecraft-ai-on-linux"


def ssh(cmd: str, check: bool = True) -> subprocess.CompletedProcess:
    """Run a command on the Linux Desktop via SSH."""
    result = subprocess.run(
        ["ssh", DESKTOP, cmd],
        capture_output=True,
        text=True,
    )
    if check and result.returncode != 0:
        print(f"  [WARN] Command exited {result.returncode}: {cmd}")
        if result.stderr.strip():
            print(f"         {result.stderr.strip()}")
    return result


def is_running(process_pattern: str) -> bool:
    """Check if a process matching the pattern is running on the desktop."""
    result = ssh(f"pgrep -f '{process_pattern}' > /dev/null 2>&1", check=False)
    return result.returncode == 0


def wait_with_dots(seconds: int, message: str):
    """Print a waiting message with progress dots."""
    print(f"  {message}", end="", flush=True)
    for _ in range(seconds):
        time.sleep(1)
        print(".", end="", flush=True)
    print()


def start_chromadb():
    """Start ChromaDB vector memory store."""
    print("[1/5] Starting ChromaDB...")
    if is_running("[c]hroma run"):
        print("  Already running — skipping")
        return True

    ssh("pkill -f '[c]hroma run' 2>/dev/null || true", check=False)
    time.sleep(1)
    ssh("bash -c 'nohup ~/chromadb/start.sh > ~/chromadb/chroma.log 2>&1 &'")
    wait_with_dots(5, "Waiting for ChromaDB")

    result = ssh("curl -sf http://localhost:8000/api/v2/heartbeat", check=False)
    if "heartbeat" in result.stdout:
        print("  ChromaDB: OK")
        return True
    else:
        print("  ChromaDB: FAILED — check ~/chromadb/chroma.log")
        return False


def start_minecraft_server():
    """Start the Minecraft Java server."""
    print("[2/5] Starting Minecraft Server...")
    if is_running("[s]erver.jar"):
        print("  Already running — skipping")
        return True

    ssh("pkill -f '[s]erver.jar' 2>/dev/null || true", check=False)
    time.sleep(2)
    ssh("cd ~/minecraft-server && nohup java -Xmx8G -Xms4G -jar server.jar nogui > server.log 2>&1 &")
    wait_with_dots(30, "Waiting for world to load")

    result = ssh("tail -5 ~/minecraft-server/server.log", check=False)
    if "Done" in result.stdout:
        print("  Minecraft Server: OK")
        return True
    else:
        print("  Minecraft Server: still loading — check ~/minecraft-server/server.log")
        return True  # May still be loading, don't block


def start_ollama_queue():
    """Start the Ollama queue proxy to prevent model swap thrashing."""
    print("[3/5] Starting Ollama Queue Proxy...")
    if is_running("[o]llama-queue"):
        print("  Already running — skipping")
        return True

    ssh(
        f"cd {PROJECT_DIR}/pipeline && "
        f"PATH={NODE_PATH} nohup node ollama-queue.js > ~/ollama-queue.log 2>&1 &"
    )
    time.sleep(2)

    if is_running("ollama-queue"):
        print("  Ollama Queue: OK")
        return True
    else:
        print("  Ollama Queue: may have failed — check ~/ollama-queue.log")
        return False


def start_mindcraft_agents():
    """Start the MindCraft AI agents (Rook, Vex, Drift, Echo, Sage)."""
    print("[4/5] Starting MindCraft Agents...")
    if is_running("[n]ode main.js"):
        print("  Already running — skipping")
        return True

    ssh(
        f"cd {PROJECT_DIR}/mindcraft && "
        f"PATH={NODE_PATH} nohup node main.js > ~/mindcraft.log 2>&1 &"
    )
    wait_with_dots(10, "Waiting for agents to connect")

    if is_running("node main.js"):
        print("  MindCraft Agents: OK")
        return True
    else:
        print("  MindCraft Agents: may have failed — check ~/mindcraft.log")
        return False


def start_nexus_orchestrator():
    """Start the Nexus orchestrator (resumes session from nexus-task-state.json)."""
    print("[5/5] Starting Nexus Orchestrator...")
    if is_running("[n]exus-orchestrator"):
        print("  Already running — skipping")
        return True

    # Check for existing session state
    state_check = ssh("cat ~/nexus-task-state.json 2>/dev/null", check=False)
    if state_check.returncode == 0 and state_check.stdout.strip():
        print("  Found existing session state — will resume")
    else:
        print("  No prior session — starting fresh")

    ssh(
        f"cd {PROJECT_DIR}/pipeline && "
        f"PATH={NODE_PATH} nohup node nexus-orchestrator.js > ~/nexus-orchestrator.log 2>&1 &"
    )
    time.sleep(3)

    if is_running("nexus-orchestrator"):
        print("  Nexus Orchestrator: OK")
        return True
    else:
        print("  Nexus Orchestrator: may have failed — check ~/nexus-orchestrator.log")
        return False


def start_all():
    """Launch the full Minecraft AI stack."""
    print("=" * 50)
    print("  Minecraft AI Stack Launcher")
    print("=" * 50)
    print()

    steps = [
        start_chromadb,
        start_minecraft_server,
        start_ollama_queue,
        start_mindcraft_agents,
        start_nexus_orchestrator,
    ]

    results = []
    for step in steps:
        results.append(step())
        print()

    print("=" * 50)
    if all(results):
        print("  All services started successfully!")
    else:
        print("  Some services may need attention — check logs above")
    print("=" * 50)
    print()
    print("Monitor logs:")
    print(f"  ssh {DESKTOP} 'tail -f ~/mindcraft.log'")
    print(f"  ssh {DESKTOP} 'tail -f ~/nexus-orchestrator.log'")
    print(f"  ssh {DESKTOP} 'tail -f ~/minecraft-server/server.log'")


def stop_all():
    """Stop all stack services."""
    print("Stopping all stack services...")
    print()

    services = [
        ("Nexus Orchestrator", "[n]exus-orchestrator"),
        ("MindCraft Agents", "[n]ode main.js"),
        ("Ollama Queue", "[o]llama-queue"),
        ("Minecraft Server", "[s]erver.jar"),
        ("ChromaDB", "[c]hroma run"),
    ]

    for name, pattern in services:
        result = ssh(f"pkill -f '{pattern}' 2>/dev/null", check=False)
        if result.returncode == 0:
            print(f"  {name}: stopped")
        else:
            print(f"  {name}: not running")

    print()
    print("All services stopped.")


def show_status():
    """Show status of all stack services."""
    print("Service Status:")
    print()

    services = [
        ("ChromaDB", "[c]hroma run"),
        ("Minecraft Server", "[s]erver.jar"),
        ("Ollama Queue", "[o]llama-queue"),
        ("MindCraft Agents", "[n]ode main.js"),
        ("Nexus Orchestrator", "[n]exus-orchestrator"),
    ]

    for name, pattern in services:
        status = "RUNNING" if is_running(pattern) else "STOPPED"
        print(f"  {name:.<30} {status}")

    # Check session state
    print()
    state = ssh("cat ~/nexus-task-state.json 2>/dev/null", check=False)
    if state.returncode == 0 and state.stdout.strip():
        import json
        try:
            data = json.loads(state.stdout)
            phase = data.get("phase", "?")
            started = data.get("phaseStartedAt", "unknown")
            milestones = len(data.get("milestones", []))
            print(f"  Session phase: {phase}")
            print(f"  Phase started: {started}")
            print(f"  Milestones completed: {milestones}")
        except json.JSONDecodeError:
            print("  Session state file exists but could not be parsed")
    else:
        print("  No existing session state found")


def main():
    parser = argparse.ArgumentParser(description="Minecraft AI Session Launcher")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--stop", action="store_true", help="Stop all services")
    group.add_argument("--status", action="store_true", help="Show service status")
    args = parser.parse_args()

    if args.stop:
        stop_all()
    elif args.status:
        show_status()
    else:
        start_all()


if __name__ == "__main__":
    main()
