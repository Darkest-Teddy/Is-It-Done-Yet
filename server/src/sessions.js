/**
 * Session tokens: the thin line between "a leaderboard" and "a text box that writes to a
 * database".
 *
 * Be honest about what this is. The score is computed on the headset, so a person who can run
 * a proxy can post any number they like with a perfectly valid token. This does not stop that
 * and cannot -- the fix is server-side scoring, which needs the whole event log and is not what
 * this project is. What it DOES stop is the cheap version: a loop posting 9,999 at a URL
 * somebody read off the network tab. That is the attack a public booth board actually gets.
 *
 * Three gates, each cheap:
 *  1. The token is an HMAC over the session id, so an id cannot be guessed or minted.
 *  2. A session is consumed once. A replayed token is a 409, not a second row.
 *  3. A run shorter than the recipe's own minimum durations did not happen.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 16 bytes of urlsafe base64. Enough that guessing is not a strategy. */
export function newSessionId() {
  return randomBytes(16).toString('base64url');
}

export function signSession(sessionId, secret) {
  return createHmac('sha256', secret).update(sessionId).digest('base64url');
}

/**
 * Constant-time, and length-checked first.
 *
 * `timingSafeEqual` THROWS on a length mismatch rather than returning false, so the obvious
 * one-liner turns a wrong-length token into a 500.
 */
export function verifySession(sessionId, token, secret) {
  if (typeof token !== 'string' || token === '') return false;
  const expected = Buffer.from(signSession(sessionId, secret));
  const actual = Buffer.from(token);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * Does this run plausibly correspond to this session?
 *
 * Returns a reason string on rejection rather than a boolean, so the client can be told which
 * gate it failed -- these are honest-mistake failures as often as not (a demo reset, a clock
 * skew), and "rejected" with no reason is the least debuggable answer there is.
 *
 * @param {object} session   the stored session document
 * @param {object} opts
 * @param {number} opts.minRunSeconds     floor for any run at all
 * @param {number} opts.maxRunSeconds     a session left open overnight is not a run
 * @param {Date}   opts.now
 */
export function checkPlausible(session, { minRunSeconds, maxRunSeconds, now = new Date() }) {
  if (session.consumedAt != null) return { ok: false, reason: 'session already used' };

  const elapsedSec = (now.getTime() - session.createdAt.getTime()) / 1000;
  if (elapsedSec < 0) return { ok: false, reason: 'session starts in the future' };

  /**
   * The floor is the larger of a flat minimum and the recipe's own timed steps.
   *
   * A recipe whose steps add up to four minutes of simmering cannot be finished in twelve
   * seconds, and that bound comes from the recipe rather than from a guess. `requiredSeconds`
   * is written onto the session when it is created, from the recipe the cook picked, so it
   * cannot be supplied by the client at submit time.
   */
  const floor = Math.max(minRunSeconds, session.requiredSeconds ?? 0);
  if (elapsedSec < floor) {
    return { ok: false, reason: `run lasted ${Math.round(elapsedSec)}s, needs at least ${Math.round(floor)}s` };
  }
  if (elapsedSec > maxRunSeconds) {
    return { ok: false, reason: 'session is too old, start a new run' };
  }
  return { ok: true, elapsedSec };
}

/**
 * The seconds a recipe cannot be finished in less than.
 *
 * Deliberately generous: 40% of the sum of the steps that declare a duration. A cook who moves
 * fast should never be told they cheated, so this is a floor against a script, not a pace
 * judgement. Steps with no `durationSec` contribute nothing, which is correct -- an untimed
 * step is one nobody measured.
 */
export function requiredSecondsFor(recipe, share = 0.4) {
  if (recipe == null || !Array.isArray(recipe.steps)) return 0;
  const total = recipe.steps.reduce((sum, step) => sum + (Number.isFinite(step.durationSec) ? step.durationSec : 0), 0);
  return Math.round(total * share);
}
