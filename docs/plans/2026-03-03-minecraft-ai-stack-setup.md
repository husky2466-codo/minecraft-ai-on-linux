# Minecraft AI Stack Setup — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stand up a fully operational Minecraft Java server + 5 MindCraft AI agents wired to the DGX Ollama endpoint, with ChromaDB vector memory, ready to connect the moment a model is pulled.

**Architecture:** Linux Desktop (10.0.0.10) hosts the Minecraft server, 5 Mineflayer bot processes, and ChromaDB. DGX (10.0.0.69) serves inference via Ollama at port 11434. Mac Mini orchestrates code via GitHub — any push triggers auto-sync to both machines via self-hosted runners.

**Tech Stack:** Java 21, Minecraft Java Server 1.21.1, Node.js 18, MindCraft (kolbytn fork), ChromaDB (Python), Ollama (llama3.3:70b on DGX)

---

## Machine Reference

| Machine | IP | User | Role |
|---------|-----|------|------|
| Mac Mini | 10.0.0.223 | myroproductions | Dev / Git push |
| Linux Desktop | 10.0.0.10 | myroproductions | Minecraft server + bots + ChromaDB |
| My DGX | 10.0.0.69 | nmyers | Ollama inference |

**SSH from Mac Mini:**
```bash
ssh myroproductions@10.0.0.10   # Linux Desktop
ssh spark                        # DGX (10.0.0.69)
```

---

## Task 1: Upgrade Java on Linux Desktop (Java 8 → Java 21)

Minecraft 1.21.x requires Java 21. The desktop currently has Java 8.

**Files:** None (system package install)

**Step 1: Install Java 21**
```bash
ssh myroproductions@10.0.0.10 "sudo apt update && sudo apt install -y openjdk-21-jdk"
```

**Step 2: Set Java 21 as default**
```bash
ssh myroproductions@10.0.0.10 "sudo update-alternatives --set java /usr/lib/jvm/java-21-openjdk-amd64/bin/java"
```

**Step 3: Verify**
```bash
ssh myroproductions@10.0.0.10 "java -version"
```
Expected: `openjdk version "21..."`

---

## Task 2: Download and Configure Minecraft Java Server

**Files:**
- Create: `~/minecraft-server/` on Linux Desktop
- Create: `~/minecraft-server/server.properties`
- Create: `~/minecraft-server/eula.txt`

**Step 1: Create server directory and download server jar**
```bash
ssh myroproductions@10.0.0.10 "
mkdir -p ~/minecraft-server && cd ~/minecraft-server &&
wget -O server.jar 'https://piston-data.mojang.com/v1/objects/e6ec2f64e6080b9b5d9b471b291c33cc7f509733/server.jar'
"
```
> This is the 1.21.1 server jar (compatible with MindCraft).

**Step 2: Accept EULA**
```bash
ssh myroproductions@10.0.0.10 "echo 'eula=true' > ~/minecraft-server/eula.txt"
```

**Step 3: Run server once to generate configs**
```bash
ssh myroproductions@10.0.0.10 "cd ~/minecraft-server && java -Xmx4G -Xms2G -jar server.jar nogui 2>&1 | tail -5"
```
Wait ~30 seconds for `Done!` to appear, then Ctrl+C.

**Step 4: Configure server for bots (offline mode + game settings)**
```bash
ssh myroproductions@10.0.0.10 "cat > ~/minecraft-server/server.properties << 'EOF'
online-mode=false
gamemode=survival
difficulty=normal
max-players=10
view-distance=8
spawn-protection=0
allow-flight=false
motd=AI Minecraft Lab
server-port=25565
EOF"
```

**Step 5: Verify server starts clean**
```bash
ssh myroproductions@10.0.0.10 "cd ~/minecraft-server && nohup java -Xmx4G -Xms2G -jar server.jar nogui > server.log 2>&1 & sleep 20 && tail -5 server.log"
```
Expected: `Done! (X.XXXs)! For help, type "help"`

**Step 6: Commit server config**
```bash
# On Mac Mini
cp -r ... # (server.properties goes in minecraft/ dir of repo)
git add minecraft/
git commit -m "Add Minecraft server config"
git push
```

---

## Task 3: Install MindCraft on Linux Desktop

**Files:**
- `~/Projects/minecraft-ai-on-linux/mindcraft/` (synced via GitHub Actions already)

**Step 1: Verify repo synced and install dependencies**
```bash
ssh myroproductions@10.0.0.10 "
cd ~/Projects/minecraft-ai-on-linux &&
git submodule update --init --recursive &&
cd mindcraft &&
npm install
"
```
Expected: `added XXX packages`

**Step 2: Create keys.json pointing to DGX (no real key needed for Ollama)**
```bash
ssh myroproductions@10.0.0.10 "cat > ~/Projects/minecraft-ai-on-linux/mindcraft/keys.json << 'EOF'
{
    \"OPENAI_API_KEY\": \"ollama\"
}
EOF"
```

**Step 3: Verify MindCraft can load**
```bash
ssh myroproductions@10.0.0.10 "cd ~/Projects/minecraft-ai-on-linux/mindcraft && node main.js --help 2>&1 | head -10"
```

---

## Task 4: Configure MindCraft Settings for 5 Agents

**Files:**
- Modify: `mindcraft/settings.js`

**Step 1: Update settings.js on Mac Mini**

Edit `mindcraft/settings.js` — change the profiles array and host:

```javascript
const settings = {
    "minecraft_version": "1.21.1",
    "host": "10.0.0.10",
    "port": 25565,
    "auth": "offline",

    "mindserver_port": 8080,
    "auto_open_ui": false,

    "base_profile": "survival",
    "profiles": [
        "./profiles/agents/rook.json",
        "./profiles/agents/vex.json",
        "./profiles/agents/sage.json",
        "./profiles/agents/echo.json",
        "./profiles/agents/drift.json",
    ],

    "load_memory": true,
    "init_message": "Introduce yourself briefly and state your current goal.",
    "only_chat_with": [],
    "chat_ingame": true,
    "language": "en",
    "render_bot_view": false,

    "allow_insecure_coding": true,
    "allow_vision": false,
    "max_messages": 15,
    "num_examples": 2,
    "max_commands": -1,
    "narrate_behavior": true,
    "chat_bot_messages": true,
    "log_all_prompts": false,
}

export default settings;
```

**Step 2: Commit and push — Actions will sync to Linux Desktop**
```bash
git add mindcraft/settings.js
git commit -m "Configure MindCraft for 5 agents pointing at DGX"
git push
```

**Step 3: Verify sync arrived on Linux Desktop**
```bash
ssh myroproductions@10.0.0.10 "cd ~/Projects/minecraft-ai-on-linux/mindcraft && git log --oneline -1"
```

---

## Task 5: Install ChromaDB on Linux Desktop

ChromaDB lives on the Linux Desktop alongside the bots. Vector memory per agent.

**Files:**
- Create: `~/chromadb/` on Linux Desktop
- Create: `pipeline/chromadb_server.sh`

**Step 1: Install ChromaDB**
```bash
ssh myroproductions@10.0.0.10 "
pip3 install --user chromadb &&
echo 'ChromaDB installed'
"
```

**Step 2: Create startup script**
```bash
ssh myroproductions@10.0.0.10 "cat > ~/chromadb/start.sh << 'EOF'
#!/bin/bash
mkdir -p ~/chromadb/data
python3 -m chromadb.server --host 0.0.0.0 --port 8000 --path ~/chromadb/data
EOF
chmod +x ~/chromadb/start.sh"
```

**Step 3: Start ChromaDB and verify**
```bash
ssh myroproductions@10.0.0.10 "nohup ~/chromadb/start.sh > ~/chromadb/chroma.log 2>&1 & sleep 5 && curl -s http://localhost:8000/api/v1/heartbeat"
```
Expected: `{"nanosecond heartbeat": XXXXXXXXX}`

**Step 4: Pre-create collections for each agent**
```bash
ssh myroproductions@10.0.0.10 "python3 << 'EOF'
import chromadb
client = chromadb.HttpClient(host='localhost', port=8000)
for agent in ['rook', 'vex', 'sage', 'echo', 'drift']:
    col = client.get_or_create_collection(f'{agent}_memory')
    print(f'Created: {agent}_memory — {col.count()} docs')
EOF"
```
Expected: 5 lines, 0 docs each.

---

## Task 6: Test Single Bot Connection (No LLM)

Before the model is ready, verify a bot can actually connect and move.

**Files:**
- Create: `minecraft/test_bot.js` on Linux Desktop

**Step 1: Create a simple headless test bot**
```javascript
// minecraft/test_bot.js
import mineflayer from 'mineflayer';

const bot = mineflayer.createBot({
    host: '10.0.0.10',
    port: 25565,
    username: 'TestBot',
    auth: 'offline',
    version: '1.21.1'
});

bot.on('spawn', () => {
    console.log('Bot spawned at', bot.entity.position);
    bot.chat('TestBot online. Connection verified.');
    setTimeout(() => {
        console.log('Test passed. Disconnecting.');
        bot.quit();
    }, 5000);
});

bot.on('error', err => console.error('Error:', err));
bot.on('kicked', reason => console.log('Kicked:', reason));
```

**Step 2: Install mineflayer standalone for the test**
```bash
ssh myroproductions@10.0.0.10 "
cd ~/Projects/minecraft-ai-on-linux/minecraft &&
npm init -y && npm install mineflayer
"
```

**Step 3: Run test (server must be running)**
```bash
ssh myroproductions@10.0.0.10 "cd ~/Projects/minecraft-ai-on-linux/minecraft && node test_bot.js"
```
Expected:
```
Bot spawned at Vec3 { x: ..., y: ..., z: ... }
Test passed. Disconnecting.
```

**Step 4: Commit**
```bash
git add minecraft/test_bot.js minecraft/package.json
git commit -m "Add mineflayer connection test"
git push
```

---

## Task 7: Build Startup Scripts

Tie everything together so one command starts the full stack.

**Files:**
- Create: `pipeline/start_stack.sh`
- Create: `pipeline/stop_stack.sh`

**Step 1: Write start_stack.sh**
```bash
# pipeline/start_stack.sh
#!/bin/bash
set -e
DESKTOP="myroproductions@10.0.0.10"

echo "=== Starting ChromaDB ==="
ssh $DESKTOP "pkill -f chromadb 2>/dev/null; nohup ~/chromadb/start.sh > ~/chromadb/chroma.log 2>&1 &"
sleep 3

echo "=== Starting Minecraft Server ==="
ssh $DESKTOP "pkill -f 'server.jar' 2>/dev/null; cd ~/minecraft-server && nohup java -Xmx8G -Xms4G -jar server.jar nogui > server.log 2>&1 &"
sleep 20

echo "=== Verifying Minecraft server ==="
ssh $DESKTOP "tail -3 ~/minecraft-server/server.log"

echo "=== Stack ready. Start MindCraft agents with: ==="
echo "  ssh $DESKTOP 'cd ~/Projects/minecraft-ai-on-linux/mindcraft && node main.js'"
```

**Step 2: Write stop_stack.sh**
```bash
# pipeline/stop_stack.sh
#!/bin/bash
DESKTOP="myroproductions@10.0.0.10"

echo "Stopping all services on Linux Desktop..."
ssh $DESKTOP "
  pkill -f 'main.js' 2>/dev/null && echo 'MindCraft stopped' || true
  pkill -f 'server.jar' 2>/dev/null && echo 'Minecraft server stopped' || true
  pkill -f chromadb 2>/dev/null && echo 'ChromaDB stopped' || true
"
echo "Done."
```

**Step 3: Make executable and commit**
```bash
chmod +x pipeline/start_stack.sh pipeline/stop_stack.sh
git add pipeline/
git commit -m "Add stack startup and shutdown scripts"
git push
```

---

## Task 8: First Full Agent Run (Requires Model on DGX)

*Run this task the morning after the model download completes.*

**Step 1: Verify model is loaded on DGX**
```bash
curl -s http://10.0.0.69:11434/api/tags | python3 -c "import json,sys; [print(m['name']) for m in json.load(sys.stdin)['models']]"
```
Expected: `llama3.3:70b`

**Step 2: Start the full stack**
```bash
./pipeline/start_stack.sh
```

**Step 3: Launch all 5 agents**
```bash
ssh myroproductions@10.0.0.10 "
cd ~/Projects/minecraft-ai-on-linux/mindcraft &&
nohup node main.js > ~/mindcraft.log 2>&1 &
tail -f ~/mindcraft.log
"
```

**Step 4: Watch in-game — all 5 bots should spawn and introduce themselves**

Expected in server log:
```
[Server] <Rook> Online. Assessing base security.
[Server] <Vex> Let's go. Who needs clearing?
[Server] <Sage> Initializing. Scanning resource availability.
[Server] <Echo> Hello team. Ready to coordinate.
[Server] <Drift> ...
```

**Step 5: Commit final state**
```bash
git add -A
git commit -m "First full 5-agent run verified"
git push
```

---

## Quick Reference — Check Everything Is Running

```bash
# Minecraft server
ssh myroproductions@10.0.0.10 "tail -3 ~/minecraft-server/server.log"

# ChromaDB
curl -s http://10.0.0.10:8000/api/v1/heartbeat

# DGX Ollama
curl -s http://10.0.0.69:11434/api/tags

# MindCraft agents
ssh myroproductions@10.0.0.10 "tail -20 ~/mindcraft.log"

# GitHub Actions (sync status)
gh run list --repo husky2466-codo/minecraft-ai-on-linux --limit 3
```
