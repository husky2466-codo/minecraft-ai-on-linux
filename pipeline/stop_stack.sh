#!/usr/bin/env bash
DESKTOP="myroproductions@10.0.0.10"

echo "Stopping all stack services on $DESKTOP..."

ssh $DESKTOP "
pkill -f '[n]ode main.js' 2>/dev/null && echo '  MindCraft agents: stopped' || echo '  MindCraft agents: not running'
pkill -f '[s]erver.jar' 2>/dev/null && echo '  Minecraft server: stopped' || echo '  Minecraft server: not running'
pkill -f '[c]hroma run' 2>/dev/null && echo '  ChromaDB: stopped' || echo '  ChromaDB: not running'
"

echo "Done."
