#!/usr/bin/env node
/**
 * A thin relay that holds the OpenAI key so the headset build does not have to.
 *
 * WHY THIS EXISTS. An APK is a zip file. A key compiled into one is extracted in minutes, and
 * it is your key with your billing and your rate limit attached. There is no obfuscation that
 * changes this -- the request has to carry the key in plaintext eventually, so anyone with the
 * build and a proxy has it. The only real fix is that the device never holds the key at all.
 *
 * So: the headset posts a chat-completions body here, this adds the Authorization header, and
 * the key stays on a machine you control.
 *
 * Deliberately dependency-free and deliberately one file. Node 18+ has fetch and http built in,
 * so this runs with `node server/vision-relay.mjs` and nothing else -- no install step to fail
 * on venue wifi at 3am, and nothing to go wrong between deciding you need it and having it.
 *
 *   OPENAI_API_KEY=sk-... node server/vision-relay.mjs
 *   # then point OpenAiVisionProvider.relayUrl at http://<your-lan-ip>:8787/vision
 *
 * For anything public, put this behind Vercel or a tunnel and add real auth. On a hackathon LAN
 * the exposure is the room you are standing in, which is a different risk than the internet.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);
const KEY = process.env.OPENAI_API_KEY ?? '';
const UPSTREAM = 'https://api.openai.com/v1/chat/completions';

// Images are a few hundred kilobytes of base64. The cap stops a malformed or hostile client
// from holding the process open forever feeding it bytes.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// Upstream timeout, comfortably under the client's. The headset gives up at 8s; if this waited
// longer it would be holding a socket for an answer nobody is listening for any more.
const UPSTREAM_TIMEOUT_MS = 20_000;

if (KEY === '') {
  console.error('OPENAI_API_KEY is not set. Refusing to start -- a relay with no key is just');
  console.error('an open proxy that returns 401s.');
  process.exit(1);
}

/** Models this relay will forward. An open relay is a bill waiting to happen. */
const ALLOWED_MODELS = new Set(['gpt-4o-mini', 'gpt-4o']);

let requests = 0;
let failures = 0;

const server = createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  // A health endpoint earns its three lines: it answers "is the relay up, or is the headset
  // failing for some other reason" without unplugging anything.
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, requests, failures }));
    return;
  }

  if (req.method !== 'POST' || !req.url?.startsWith('/vision')) {
    res.writeHead(404, cors);
    res.end('not found');
    return;
  }

  let body = '';
  let size = 0;
  let aborted = false;

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      res.writeHead(413, cors);
      res.end('payload too large');
      req.destroy();
      return;
    }
    body += chunk;
  });

  req.on('end', async () => {
    if (aborted) return;
    requests++;

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      failures++;
      res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'body was not JSON' }));
      return;
    }

    if (!ALLOWED_MODELS.has(parsed.model)) {
      failures++;
      res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `model not allowed: ${parsed.model}` }));
      return;
    }

    const started = Date.now();
    try {
      const upstream = await fetch(UPSTREAM, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${KEY}`,
        },
        body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

      const text = await upstream.text();
      const ms = Date.now() - started;
      if (!upstream.ok) failures++;
      console.log(`${upstream.status} ${ms}ms  ${(size / 1024).toFixed(0)}kb`);

      res.writeHead(upstream.status, { ...cors, 'Content-Type': 'application/json' });
      res.end(text);
    } catch (error) {
      failures++;
      console.error('upstream failed:', error.message);
      // 502 rather than 500: this relay is fine, the thing behind it is not, and the client
      // should fall back rather than retry into a wall.
      res.writeHead(502, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream failed', detail: error.message }));
    }
  });
});

// 0.0.0.0 so the headset can reach it over the LAN. localhost would bind only this machine,
// which is the one device that does not need it.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`vision relay on http://0.0.0.0:${PORT}/vision`);
  console.log('point OpenAiVisionProvider.relayUrl at http://<this-machine-lan-ip>:' + PORT + '/vision');
});
