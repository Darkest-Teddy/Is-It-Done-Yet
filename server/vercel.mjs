/**
 * Adapts the three `(req, res)` relay handlers to Vercel's serverless Node runtime.
 *
 * WHY THIS EXISTS AT ALL. `server/static.mjs` is a long-running `node:http` server, and Vercel
 * does not run one. A static deployment there is a CDN plus a pool of functions under `api/`,
 * so the routes `static.mjs` mounts -- `/api/guidance`, `/api/speech`, `/api/vision` -- simply
 * do not exist on the deployed site, and every model-backed feature falls through to its local
 * fallback without saying so. The fallbacks are deliberate and good; silently never leaving
 * them is not.
 *
 * WHY IT IS AN ADAPTER AND NOT A SECOND IMPLEMENTATION. The handlers were written as
 * `(req, res) => Promise<void>` precisely so three hosts could share them: `vite.config.ts`
 * mounts them as connect middleware for the dev server, `static.mjs` mounts them on a raw
 * `http` server, and `api/*.js` mounts them here. A forked copy would drift -- the prompt, the
 * timeout, the clamping and the 503-means-unconfigured contract all live in one file each, and
 * they stay there.
 *
 * THE ONE INCOMPATIBILITY, AND IT IS THE WHOLE FILE. All three handlers read their POST body
 * off the request stream. Vercel's Node runtime attaches `req.body` helpers that may already
 * have consumed that stream, in which case the handler's `req.on('data')` fires never and its
 * `'end'` fires immediately, and `JSON.parse('')` throws -- which the handlers report as
 * "body was not JSON", a message that blames the browser for a host difference. Rather than
 * guess which version of the runtime is underneath, this reads the body whichever way it is
 * available and hands the handler a fresh `Readable` carrying those exact bytes. The handler
 * cannot tell the difference, including its own size ceiling, because the ceiling is applied
 * to the same chunks either way.
 *
 * The response object needs no adaptation: Vercel's is a real `ServerResponse`, so
 * `writeHead().end()` and the binary `res.end(buffer)` in `speech.mjs` work unchanged.
 */

import { Readable } from 'node:stream';

/**
 * The request body as bytes, from whichever of the two places it is.
 *
 * `req.body` is read first and defensively. On the runtimes that parse eagerly it is already
 * an object; on the ones that parse lazily, touching it is what triggers the parse, and on a
 * GET there is nothing to parse and it is `undefined`. Any of those three is fine. Only when
 * it yields nothing is the stream drained, which is the non-Vercel path and the local one.
 */
async function bodyBytes(req) {
  let parsed;
  try {
    parsed = req.body;
  } catch {
    parsed = undefined;
  }

  if (Buffer.isBuffer(parsed)) return parsed;
  if (typeof parsed === 'string') return Buffer.from(parsed, 'utf8');
  // An object here means the runtime parsed JSON for us. Re-serialising is lossless for
  // everything these three endpoints accept, and it keeps the handler's own parse the only
  // place a malformed body is judged.
  if (parsed !== undefined && parsed !== null) return Buffer.from(JSON.stringify(parsed), 'utf8');

  if (req.readableEnded === true || req.destroyed === true) return Buffer.alloc(0);

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Wraps one shared handler as a Vercel function.
 *
 * Errors are caught here rather than left to the platform. An uncaught throw becomes a
 * `FUNCTION_INVOCATION_FAILED` page in HTML, and every one of these clients reads the status
 * and then the JSON body; an HTML 500 makes them report a parse failure instead of an outage.
 * 502 with a JSON body is the shape they already handle.
 */
export function vercelHandler(handler) {
  return async function vercelFunction(req, res) {
    try {
      const bytes = await bodyBytes(req);

      // A fresh stream carrying the same bytes, with the fields the handlers actually read.
      // Prototype-chained to the real request so anything not overridden -- `socket`,
      // `httpVersion`, the rest -- still answers.
      const shim = Readable.from(bytes.length === 0 ? [] : [bytes]);
      shim.method = req.method;
      shim.url = req.url;
      shim.headers = req.headers;

      await handler(shim, res);
    } catch (error) {
      console.error('[vercel] handler threw', error);
      if (res.headersSent) {
        res.end();
        return;
      }
      const text = JSON.stringify({ error: 'relay failed' });
      res.writeHead(502, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store',
      });
      res.end(text);
    }
  };
}
