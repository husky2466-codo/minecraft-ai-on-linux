import mineflayer from 'mineflayer';
import { Rcon } from 'rcon-client';
import readline from 'readline';

const BOT_HOST = '10.0.0.10';
const RCON_PASSWORD = 'ailab743915';

const bot = mineflayer.createBot({
    host: BOT_HOST,
    port: 25565,
    username: 'Claude',
    auth: 'offline',
    version: '1.21.1'
});

const rcon = new Rcon({ host: BOT_HOST, port: 25575, password: RCON_PASSWORD });

bot.on('spawn', async () => {
    console.log(`\n[BOT] Claude spawned at ${JSON.stringify(bot.entity.position)}`);
    bot.chat('Claude is online.');
    await rcon.connect();
    console.log('[RCON] Connected to server console\n');
    showHelp();
    startCLI();
});

bot.on('chat', (username, message) => {
    if (username !== 'Claude') console.log(`[CHAT] <${username}> ${message}`);
});

bot.on('error', err => console.error('[ERROR]', err.message));
bot.on('kicked', reason => console.log('[KICKED]', reason));
bot.on('end', () => { console.log('[BOT] Disconnected'); process.exit(0); });

function showHelp() {
    console.log('Commands:');
    console.log('  chat <message>        — bot says something in-game');
    console.log('  move <f/b/l/r> <ms>  — move bot (forward/back/left/right)');
    console.log('  jump                  — bot jumps');
    console.log('  look <yaw> <pitch>   — rotate bot view');
    console.log('  pos                   — show bot position');
    console.log('  inv                   — list inventory');
    console.log('  rcon <command>        — run server command (e.g. rcon give Claude diamond 5)');
    console.log('  quit                  — disconnect\n');
}

function startCLI() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'claude> ' });
    rl.prompt();

    rl.on('line', async (line) => {
        const [cmd, ...args] = line.trim().split(' ');
        try {
            switch(cmd) {
                case 'chat':
                    bot.chat(args.join(' '));
                    break;
                case 'move':
                    const dir = args[0] || 'forward';
                    const ms = parseInt(args[1]) || 1000;
                    const ctrl = { forward: 'forward', f: 'forward', back: 'back', b: 'back', left: 'left', l: 'left', right: 'right', r: 'right' }[dir] || 'forward';
                    bot.setControlState(ctrl, true);
                    await new Promise(r => setTimeout(r, ms));
                    bot.setControlState(ctrl, false);
                    console.log(`[BOT] Moved ${ctrl} for ${ms}ms`);
                    break;
                case 'jump':
                    bot.setControlState('jump', true);
                    await new Promise(r => setTimeout(r, 400));
                    bot.setControlState('jump', false);
                    console.log('[BOT] Jumped');
                    break;
                case 'look':
                    bot.look(parseFloat(args[0]) || 0, parseFloat(args[1]) || 0, true);
                    console.log(`[BOT] Looking at yaw=${args[0]} pitch=${args[1]}`);
                    break;
                case 'pos':
                    const p = bot.entity.position;
                    console.log(`[BOT] Position: x=${p.x.toFixed(2)} y=${p.y.toFixed(2)} z=${p.z.toFixed(2)}`);
                    break;
                case 'inv':
                    const items = bot.inventory.items();
                    if (items.length === 0) console.log('[INV] Empty');
                    else items.forEach(i => console.log(`[INV] ${i.name} x${i.count}`));
                    break;
                case 'rcon':
                    const result = await rcon.send(args.join(' '));
                    console.log(`[RCON] ${result || '(no output)'}`);
                    break;
                case 'quit':
                    bot.quit();
                    await rcon.end();
                    rl.close();
                    break;
                case 'help':
                    showHelp();
                    break;
                default:
                    if (cmd) console.log(`Unknown command: ${cmd}. Type 'help' for list.`);
            }
        } catch(e) {
            console.error('[ERR]', e.message);
        }
        rl.prompt();
    });
}
