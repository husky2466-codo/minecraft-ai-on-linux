#!/usr/bin/env node
// Ollama request queue proxy
// Prevents model swap thrashing by serializing requests per model family
// 7B requests queue separately from 14B requests
// Agents point to :11435, this proxies to Ollama on :11434

const http = require('http');

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const PROXY_PORT = 11435;

function getFamily(model = '') {
  const m = model.toLowerCase();
  if (m.match(/1[3-9]b|[2-9][0-9]b/)) return '14b';
  if (m.includes('14b') || m.includes('32b') || m.includes('70b')) return '14b';
  return '7b';
}

const queues = { '7b': [], '14b': [] };
const active = { '7b': false, '14b': false };
let totalQueued = 0;
let totalServed = 0;

function enqueue(family, entry) {
  totalQueued++;
  queues[family].push(entry);
  const pos = queues[family].length;
  if (pos > 1) console.log(`[queue] ${entry.agent || '?'} queued at position ${pos} in ${family} queue`);
  if (!active[family]) pump(family);
}

async function pump(family) {
  if (queues[family].length === 0) { active[family] = false; return; }
  active[family] = true;
  const entry = queues[family].shift();
  const start = Date.now();
  try {
    await forward(entry.path, entry.body, entry.res);
    totalServed++;
    console.log(`[queue] ${entry.agent || '?'} (${family}) served in ${Date.now() - start}ms | served=${totalServed} queued=${queues[family].length}`);
  } catch (e) {
    console.error(`[queue] forward error for ${entry.agent}: ${e.message}`);
    if (!entry.res.writableEnded) {
      entry.res.writeHead(500, { 'Content-Type': 'application/json' });
      entry.res.end(JSON.stringify({ error: e.message }));
    }
  }
  pump(family);
}

function forward(path, body, clientRes) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const opts = {
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
      },
    };
    const req = http.request(opts, (ollamaRes) => {
      clientRes.writeHead(ollamaRes.statusCode, ollamaRes.headers);
      ollamaRes.on('data', chunk => clientRes.write(chunk));
      ollamaRes.on('end', () => { clientRes.end(); resolve(); });
      ollamaRes.on('error', reject);
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function passthrough(req, res, body) {
  const data = Buffer.from(body);
  const opts = {
    hostname: OLLAMA_HOST,
    port: OLLAMA_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${OLLAMA_HOST}:${OLLAMA_PORT}`,
      'content-length': data.length,
    },
  };
  const proxyReq = http.request(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  });
  proxyReq.write(data);
  proxyReq.end();
}

const server = http.createServer((req, res) => {
  let rawBody = '';
  req.on('data', chunk => rawBody += chunk);
  req.on('end', () => {
    const isInference = req.method === 'POST' &&
      (req.url === '/api/chat' || req.url === '/api/generate');

    if (isInference) {
      let body = {};
      try { body = JSON.parse(rawBody); } catch (_) {}
      const family = getFamily(body.model || '');
      const agent = body.messages?.at(-1)?.content?.slice(0, 20) || body.model || '?';
      enqueue(family, { res, body, path: req.url, agent: body.model });
    } else {
      passthrough(req, res, rawBody);
    }
  });
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`[ollama-queue] Proxy on :${PROXY_PORT} → Ollama :${OLLAMA_PORT}`);
  console.log(`[ollama-queue] Queuing /api/chat and /api/generate by model family`);
  console.log(`[ollama-queue] 7b queue and 14b queue run independently`);
});

server.on('error', (e) => {
  console.error('[ollama-queue] Server error:', e.message);
  process.exit(1);
});
