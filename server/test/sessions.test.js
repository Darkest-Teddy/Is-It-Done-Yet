/**
 * Session tokens and the plausibility floor.
 *
 * Pure functions, no database. The point of the file is to pin the behaviours that would fail
 * silently: a wrong-length token must be false rather than an exception, and a run that is too
 * short must be rejected for a reason somebody can read.
 */

import { describe, expect, it } from 'vitest';

import { checkPlausible, newSessionId, requiredSecondsFor, signSession, verifySession } from '../src/sessions.js';

const SECRET = 'a-secret';

describe('token signing', () => {
  it('round-trips', () => {
    const id = newSessionId();
    expect(verifySession(id, signSession(id, SECRET), SECRET)).toBe(true);
  });

  it('rejects a token signed with a different secret', () => {
    const id = newSessionId();
    expect(verifySession(id, signSession(id, 'other'), SECRET)).toBe(false);
  });

  it('rejects a token for a different session', () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(verifySession(a, signSession(b, SECRET), SECRET)).toBe(false);
  });

  /**
   * The one that would be a 500 rather than a 401: `timingSafeEqual` throws on a length
   * mismatch, so the obvious implementation turns a truncated token into a crash.
   */
  it('returns false for a wrong-length token instead of throwing', () => {
    const id = newSessionId();
    expect(verifySession(id, 'short', SECRET)).toBe(false);
    expect(verifySession(id, `${signSession(id, SECRET)}xx`, SECRET)).toBe(false);
  });

  it('returns false for a missing or non-string token', () => {
    const id = newSessionId();
    expect(verifySession(id, '', SECRET)).toBe(false);
    expect(verifySession(id, undefined, SECRET)).toBe(false);
    expect(verifySession(id, null, SECRET)).toBe(false);
  });

  it('mints ids that do not collide', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newSessionId()));
    expect(ids.size).toBe(500);
  });
});

describe('plausibility', () => {
  const opts = { minRunSeconds: 20, maxRunSeconds: 3600 };
  const session = (over = {}) => ({ createdAt: new Date(0), consumedAt: null, requiredSeconds: 0, ...over });
  const at = (seconds) => new Date(seconds * 1000);

  it('accepts a run past the flat minimum', () => {
    expect(checkPlausible(session(), { ...opts, now: at(25) })).toMatchObject({ ok: true });
  });

  it('rejects a run under the flat minimum, and says by how much', () => {
    const result = checkPlausible(session(), { ...opts, now: at(5) });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/5s, needs at least 20s/);
  });

  it("uses the recipe's own floor when it is higher", () => {
    const result = checkPlausible(session({ requiredSeconds: 300 }), { ...opts, now: at(120) });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/at least 300s/);
  });

  it('keeps the flat minimum when the recipe has no timed steps', () => {
    expect(checkPlausible(session({ requiredSeconds: 0 }), { ...opts, now: at(21) }).ok).toBe(true);
  });

  it('rejects a session that was already consumed', () => {
    const result = checkPlausible(session({ consumedAt: new Date(1000) }), { ...opts, now: at(600) });
    expect(result).toMatchObject({ ok: false, reason: 'session already used' });
  });

  it('rejects a session left open past the ceiling', () => {
    expect(checkPlausible(session(), { ...opts, now: at(7200) }).ok).toBe(false);
  });

  /** Clock skew between a headset and a server is real; a negative elapsed is not a run. */
  it('rejects a session that claims to start in the future', () => {
    expect(checkPlausible(session({ createdAt: new Date(10_000) }), { ...opts, now: at(5) }).ok).toBe(false);
  });
});

describe('requiredSecondsFor', () => {
  it('takes 40% of the summed step durations', () => {
    const recipe = { steps: [{ durationSec: 100 }, { durationSec: 200 }] };
    expect(requiredSecondsFor(recipe)).toBe(120);
  });

  it('ignores steps with no declared duration', () => {
    const recipe = { steps: [{ durationSec: 100 }, { text: 'season to taste' }] };
    expect(requiredSecondsFor(recipe)).toBe(40);
  });

  it('is zero for no recipe, so an ad-hoc run still has the flat minimum', () => {
    expect(requiredSecondsFor(null)).toBe(0);
    expect(requiredSecondsFor(undefined)).toBe(0);
    expect(requiredSecondsFor({})).toBe(0);
  });
});
