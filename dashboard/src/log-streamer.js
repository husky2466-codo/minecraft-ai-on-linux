import { Client } from 'ssh2';
import { readFileSync } from 'fs';

const SSH_CONFIG = {
  host: '10.0.0.10',
  username: 'myroproductions',
  privateKey: readFileSync(process.env.SSH_KEY_PATH || '/Users/myroproductions/.ssh/id_ed25519'),
};

const ALLOWED_REMOTE_PATHS = [
  '/home/myroproductions/mindcraft.log',
  '/home/myroproductions/minecraft-server/server.log',
];
const MINDCRAFT_BOTS_BASE = '/home/myroproductions/Projects/minecraft-ai-on-linux/mindcraft/bots/';

function validateRemotePath(filePath) {
  // Allow known log paths
  if (ALLOWED_REMOTE_PATHS.includes(filePath)) return;
  // Allow memory.json files under the bots/ directory (safe agent names only)
  if (filePath.startsWith(MINDCRAFT_BOTS_BASE) && /^[A-Za-z0-9_\-/\.]+$/.test(filePath)) return;
  throw new Error(`Remote path not allowed: ${filePath}`);
}

export function tailLog(logPath, onLine) {
  validateRemotePath(logPath);
  const conn = new Client();
  conn.on('ready', () => {
    conn.exec(`tail -F ${logPath}`, (err, stream) => {
      if (err) { console.error('[SSH]', err.message); return; }
      let buffer = '';
      stream.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line
        lines.forEach(line => { if (line.trim()) onLine(line); });
      });
      stream.on('close', () => {
        console.log('[SSH] Log stream closed, reconnecting in 5s...');
        conn.end();
        setTimeout(() => tailLog(logPath, onLine), 5000);
      });
    });
  });
  conn.on('error', (err) => {
    console.warn('[SSH] Error:', err.message, '— retrying in 5s');
    conn.end();
    setTimeout(() => tailLog(logPath, onLine), 5000);
  });
  conn.connect(SSH_CONFIG);
}

export async function readRemoteFile(filePath) {
  validateRemotePath(filePath);
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.exec(`cat ${filePath}`, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        let data = '';
        stream.stdout.on('data', chunk => data += chunk);
        stream.on('close', (code) => {
          conn.end();
          if (code !== 0) {
            reject(new Error(`Remote command failed with exit code ${code}: ${filePath}`));
          } else {
            resolve(data);
          }
        });
      });
    });
    conn.on('error', reject);
    conn.connect(SSH_CONFIG);
  });
}

export async function runRemoteCommand(cmd) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        let stdout = '', stderr = '';
        stream.stdout.on('data', d => stdout += d);
        stream.stderr.on('data', d => stderr += d);
        stream.on('close', (code) => { conn.end(); resolve({ stdout, stderr, code }); });
      });
    });
    conn.on('error', reject);
    conn.connect(SSH_CONFIG);
  });
}
