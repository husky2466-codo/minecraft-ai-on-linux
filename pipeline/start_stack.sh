#!/usr/bin/env bash
set -euo pipefail
DESKTOP="myroproductions@10.0.0.10"

echo "=== [1/3] Starting ChromaDB ==="
ssh $DESKTOP "pkill -f '[c]hroma run' 2>/dev/null || true; sleep 1; bash -c 'nohup ~/chromadb/start.sh > ~/chromadb/chroma.log 2>&1 &'"
sleep 5
if ssh $DESKTOP "curl -s http://localhost:8000/api/v2/heartbeat" | grep -q heartbeat; then
    echo "    ChromaDB: OK"
else
    echo "    ChromaDB: FAILED — check ~/chromadb/chroma.log on Linux Desktop"
    exit 1
fi

echo "=== [2/3] Starting Minecraft Server ==="
ssh $DESKTOP "pkill -f '[s]erver.jar' 2>/dev/null || true"
sleep 2
ssh $DESKTOP "cd ~/minecraft-server && nohup java -Xmx8G -Xms4G -jar server.jar nogui > server.log 2>&1 &"
echo "    Waiting 30s for world to load..."
sleep 30
if ssh $DESKTOP "tail -5 ~/minecraft-server/server.log" | grep -q "Done"; then
    echo "    Minecraft: OK"
else
    echo "    Minecraft: Still loading or failed — check ~/minecraft-server/server.log on Linux Desktop"
fi

echo ""
echo "=== Stack ready ==="
echo "Launch agents with:"
echo "  ssh $DESKTOP 'cd ~/Projects/minecraft-ai-on-linux/mindcraft && PATH=\$HOME/.nvm/versions/node/v22.22.0/bin:\$HOME/.local/bin:\$PATH nohup node main.js > ~/mindcraft.log 2>&1 &'"
echo ""
echo "Monitor:"
echo "  ssh $DESKTOP 'tail -f ~/mindcraft.log'"
echo "  ssh $DESKTOP 'tail -f ~/minecraft-server/server.log'"
