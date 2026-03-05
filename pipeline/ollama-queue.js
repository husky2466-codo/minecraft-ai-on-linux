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

// Max items waiting per queue. When full, return an immediate no-op response
// so the agent idles instead of piling up retries.
const MAX_QUEUE_DEPTH = 4;

const queues = { '7b': [], '14b': [] };
const active = { '7b': false, '14b': false };
let totalQueued = 0;
let totalServed = 0;
let totalDropped = 0;

function noopResponse(path, model, res) {
  const now = new Date().toISOString();
  let payload;
  if (path === '/api/chat') {
    payload = JSON.stringify({
      model, created_at: now,
      message: { role: 'assistant', content: '\t' },
      done_reason: 'stop', done: true,
    });
  } else {
    payload = JSON.stringify({ model, created_at: now, response: '\t', done: true, done_reason: 'stop' });
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function enqueue(family, entry) {
  if (queues[family].length >= MAX_QUEUE_DEPTH) {
    totalDropped++;
    console.log(`[queue] DROPPED ${entry.agent || '?'} (${family} queue full at ${MAX_QUEUE_DEPTH}) | dropped=${totalDropped}`);
    noopResponse(entry.path, entry.body.model || family, entry.res);
    return;
  }
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
      // Return a valid chat response so MindCraft doesn't crash on missing message.content
      noopResponse(entry.path, entry.body.model || 'unknown', entry.res);
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

    const json = (data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

    if (req.method === 'GET' && req.url === '/queue/stats') {
      json({ '7b': queues['7b'].length, '14b': queues['14b'].length, served: totalServed, dropped: totalDropped });
    } else if (req.method === 'POST' && req.url === '/queue/clear') {
      const dropped7 = queues['7b'].length;
      const dropped14 = queues['14b'].length;
      queues['7b'].forEach(e => { if (!e.res.writableEnded) { e.res.writeHead(200, { 'Content-Type': 'application/json' }); e.res.end(JSON.stringify({ model: e.body.model, response: '\t', done: true })); } });
      queues['14b'].forEach(e => { if (!e.res.writableEnded) { e.res.writeHead(200, { 'Content-Type': 'application/json' }); e.res.end(JSON.stringify({ model: e.body.model, response: '\t', done: true })); } });
      queues['7b'] = [];
      queues['14b'] = [];
      console.log(`[queue] CLEARED — flushed ${dropped7} 7b + ${dropped14} 14b items`);
      json({ cleared: { '7b': dropped7, '14b': dropped14 } });
    } else if (isInference) {
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
