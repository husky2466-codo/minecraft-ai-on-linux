import { Rcon } from 'rcon-client';

const rcon = new Rcon({ host: '10.0.0.10', port: 25575, password: 'ailab743915' });
let connected = false;

async function ensureConnected() {
  if (!connected) {
    await rcon.connect();
    connected = true;
    rcon.socket.on('close', () => { connected = false; });
  }
}

export async function sendRcon(command) {
  await ensureConnected();
  return rcon.send(command);
}
