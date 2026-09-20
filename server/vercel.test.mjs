/**
 * `vercelHandler`, which is the one piece of the deployment that cannot be checked by opening
 * the site.
 *
 * The wrapper exists because Vercel's Node runtime may hand a function a request whose body has
 * already been read off the stream and parked on `req.body`. Every one of the three relay
 * handlers reads the body by listening for `'data'`, so on that runtime they would see an empty
 * body and report "body was not JSON" -- a message that blames the browser for a host
 * difference, on the one code path nobody can reproduce locally.
 *
 * So the test is the runtime, four ways: body already parsed to an object, body already read to
 * a string, body still on the stream, and no body at all. What is asserted is that the handler
 * underneath cannot tell which it was. If that ever stops being true, the symptom on the
 * deployed site is a 400 on every POST and a chef that has quietly gone back to its local
 * answers, which is indistinguishable from the route not existing.
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'vitest';

import { vercelHandler } from './vercel.mjs';

/** A `ServerResponse` stand-in that records rather than writes. */
function mockRes() {
  const res = {
    status: null,
    headers: null,
    body: null,
    headersSent: false,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers ?? null;
      res.headersSent = true;
      return res;
    },
    end(chunk) {
      res.body = chunk === undefined ? '' : chunk;
    },
  };
  return res;
}

/** A request whose body is still on the stream, the way `static.mjs` and Vite deliver it. */
function streamReq(method, text) {
  const req = Readable.from(text === undefined ? [] : [Buffer.from(text, 'utf8')]);
  req.method = method;
  req.url = '/api/test';
  req.headers = { 'content-type': 'application/json' };
  return req;
}

/** A request the platform has already drained, the way Vercel may deliver it. */
function drainedReq(method, body) {
  const req = Readable.from([]);
  req.method = method;
  req.url = '/api/test';
  req.headers = { 'content-type': 'application/json' };
  req.body = body;
  return req;
}

/** Records exactly what the wrapped handler saw. */
function recorder() {
  const seen = { method: null, text: null };
  const handler = async (req, res) => {
    seen.method = req.method;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.text = Buffer.concat(chunks).toString('utf8');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  };
  return { seen, fn: vercelHandler(handler) };
}

describe('vercelHandler body adaptation', () => {
  it('passes a streamed body through byte for byte', async () => {
    const { seen, fn } = recorder();
    await fn(streamReq('POST', '{"text":"hello"}'), mockRes());
    assert.equal(seen.text, '{"text":"hello"}');
  });

  it('re-serialises a body the platform already parsed into an object', async () => {
    // This is the case that fails without the wrapper: the stream is empty, the bytes are on
    // `req.body`, and the handler's own `JSON.parse` would receive `''`.
    const { seen, fn } = recorder();
    await fn(drainedReq('POST', { text: 'hello' }), mockRes());
    assert.deepEqual(JSON.parse(seen.text), { text: 'hello' });
  });

  it('passes a body the platform read to a string', async () => {
    const { seen, fn } = recorder();
    await fn(drainedReq('POST', '{"text":"hello"}'), mockRes());
    assert.equal(seen.text, '{"text":"hello"}');
  });

  it('passes a body the platform read to a Buffer', async () => {
    const { seen, fn } = recorder();
    await fn(drainedReq('POST', Buffer.from('{"text":"hello"}')), mockRes());
    assert.equal(seen.text, '{"text":"hello"}');
  });

  it('gives a GET an empty body rather than hanging on a stream that never ends', async () => {
    // `/api/vision` answers GET, and the client asks GET first to decide whether it can offer
    // the "Identify everything" control at all. A wrapper that waited for a body here would
    // turn that probe into a timeout and the button into a dead one.
    const { seen, fn } = recorder();
    await fn(drainedReq('GET', undefined), mockRes());
    assert.equal(seen.method, 'GET');
    assert.equal(seen.text, '');
  });

  it('keeps the method and headers the handler dispatches on', async () => {
    const { seen, fn } = recorder();
    await fn(streamReq('POST', '{}'), mockRes());
    assert.equal(seen.method, 'POST');
  });

  it('survives a `req.body` getter that throws, by falling back to the stream', async () => {
    // A lazy body helper that throws must not take the request with it. Reading the stream is
    // the correct answer in that case and it is still intact.
    const req = streamReq('POST', '{"text":"hello"}');
    Object.defineProperty(req, 'body', {
      get() { throw new Error('lazy parse failed'); },
    });
    const { seen, fn } = recorder();
    await fn(req, mockRes());
    assert.equal(seen.text, '{"text":"hello"}');
  });
});

describe('vercelHandler failure', () => {
  it('answers 502 with JSON when the handler throws, not an HTML crash page', async () => {
    // Every client here reads the status and then the JSON body. An uncaught throw becomes
    // Vercel's own HTML error page, so the browser reports a parse failure instead of an
    // outage -- the wrong diagnosis at the worst moment.
    const res = mockRes();
    const fn = vercelHandler(async () => { throw new Error('upstream exploded'); });
    await fn(streamReq('POST', '{}'), res);
    assert.equal(res.status, 502);
    assert.deepEqual(JSON.parse(res.body), { error: 'relay failed' });
  });

  it('does not try to write a second head when the handler already answered', async () => {
    const res = mockRes();
    const fn = vercelHandler(async (_req, r) => {
      r.writeHead(200, {});
      throw new Error('threw after answering');
    });
    await fn(streamReq('POST', '{}'), res);
    assert.equal(res.status, 200);
  });
});

describe('the three mounted routes', () => {
  it('each api/ function exports a handler function', async () => {
    for (const name of ['guidance', 'speech', 'vision']) {
      const module = await import(`../api/${name}.js`);
      assert.equal(typeof module.default, 'function', `api/${name}.js has no default export`);
    }
  });

  it('answers the unconfigured vision probe, so the button can explain itself', async () => {
    // With no key this must still be a 200 saying `configured: false`. `scan.ts` reads exactly
    // that to decide between a working control and one disabled with a reason; a 404 -- which
    // is what the deployed site returns today for guidance and speech -- reads as neither.
    const vision = (await import('../api/vision.js')).default;
    const res = mockRes();
    await vision(drainedReq('GET', undefined), res);
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.configured, 'boolean');
  });
});
