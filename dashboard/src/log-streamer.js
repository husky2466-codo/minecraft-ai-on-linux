import { Client } from 'ssh2';
import { readFileSync } from 'fs';

const SSH_CONFIG = {
  host: '10.0.0.10',
  username: 'myroproductions',
  privateKey: readFileSync('/Users/myroproductions/.ssh/id_ed25519'),
};

export function tailLog(logPath, onLine) {
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
    setTimeout(() => tailLog(logPath, onLine), 5000);
  });
  conn.connect(SSH_CONFIG);
}

export async function readRemoteFile(filePath) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.exec(`cat ${filePath}`, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        let data = '';
        stream.stdout.on('data', chunk => data += chunk);
        stream.on('close', () => { conn.end(); resolve(data); });
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
