import mineflayer from 'mineflayer';

const bot = mineflayer.createBot({
  host: '10.0.0.10',
  port: 25565,
  username: 'TestBot',
  version: '1.21.1',
  auth: 'offline',
});

bot.once('spawn', () => {
  console.log('Bot spawned at', bot.entity.position);
  bot.chat('TestBot online. Connection verified.');
  console.log('Test passed. Disconnecting.');
  setTimeout(() => {
    bot.quit();
  }, 5000);
});

bot.on('error', (err) => {
  console.error('Bot error:', err);
});

bot.on('kicked', (reason) => {
  console.log('Bot was kicked:', reason);
});

bot.on('end', () => {
  console.log('Bot disconnected.');
  process.exit(0);
});
