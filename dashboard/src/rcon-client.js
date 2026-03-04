import { Rcon } from 'rcon-client';

const rcon = new Rcon({ host: '10.0.0.10', port: 25575, password: 'ailab743915' });
let connected = false;
let connectPromise = null;

async function ensureConnected() {
  if (!connected) {
    if (!connectPromise) {
      connectPromise = rcon.connect().then(() => {
        connected = true;
        rcon.socket.on('close', () => { connected = false; });
      }).catch((err) => {
        throw err;
      }).finally(() => {
        connectPromise = null;
      });
    }
    await connectPromise;
  }
}

export async function sendRcon(command) {
  await ensureConnected();
  return rcon.send(command);
}
