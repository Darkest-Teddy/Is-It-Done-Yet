/**
 * Makes every test request close its socket, instead of leaving it in a pool.
 *
 * The bug this fixes is entirely a property of the harness, and it took a loop to find.
 *
 * Node 19 made the global HTTP agent keep-alive by default. supertest starts an EPHEMERAL
 * server per `request(app)` and closes it when the response lands -- so a pooled socket can
 * outlive the server it was opened against, and the OS then hands that same port to the next
 * ephemeral server. The pooled socket, still believed good, writes its request into a
 * different server and reads back whatever that one is saying mid-stream.
 *
 * It surfaced as `Parse Error: Expected HTTP/, RTSP/ or ICE/` on an arbitrary test, roughly
 * one run in five, never twice on the same test. The default reporter prints the count and
 * swallows the message, which is why it read as ordinary flakiness for several runs.
 *
 * Replacing `http.globalAgent` is NOT enough: superagent, which supertest is built on, does
 * not route through it. Forcing `Connection: close` on the request itself is what actually
 * takes the socket out of circulation.
 *
 * The server is not affected. A real client talks to one long-lived server and never sees this.
 */

import http from 'node:http';
import https from 'node:https';
import supertest from 'supertest';

http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });

const { Test } = supertest;
const originalEnd = Test.prototype.end;
Test.prototype.end = function patchedEnd(...args) {
  this.set('Connection', 'close');
  return originalEnd.apply(this, args);
};
