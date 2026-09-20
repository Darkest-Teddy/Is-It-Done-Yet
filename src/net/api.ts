/**
 * The recipe-book and leaderboard API, as seen from the headset.
 *
 * Two rules from the master spec shape every line here. Rule #9: every network call gets a
 * timeout and a fallback. Rule #12: when in doubt, pick what survives a live demo on bad wifi.
 * So nothing in this file can throw at a caller -- each function returns a result the UI can
 * render, including the failure -- and every call is on a clock short enough that a stalled
 * request is visibly over rather than a spinner nobody trusts.
 *
 * `VITE_API_URL` is read at BUILD time. Unset, `configured` is false and every call returns a
 * failure immediately without touching the network, which is what makes the offline path the
 * default rather than a degraded mode somebody has to remember to test.
 */

import { toRecipe, toRecipes, type NewRecipeDoc, type RecipeDoc } from '../core/recipeDoc.js';
import type { Recipe } from '../core/recipe.js';

const RAW_BASE = import.meta.env['VITE_API_URL'] as string | undefined;

/** Trailing slashes off once, here, so no call site has to think about it. */
export const API_BASE = RAW_BASE === undefined || RAW_BASE.trim() === ''
  ? null
  : RAW_BASE.trim().replace(/\/+$/, '');

export const configured = API_BASE !== null;

/**
 * Deliberately short. Render's free tier can take 30s to wake a sleeping instance, and waiting
 * that out in front of a judge is worse than showing the local board instantly -- so the
 * DEPLOY notes say to warm the API before judging rather than raising this number.
 */
const TIMEOUT_MS = 4_000;
const RETRY_DELAY_MS = 400;

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string; readonly offline: boolean };

const fail = (error: string, offline = false): ApiResult<never> => ({ ok: false, error, offline });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * One request, with a hard deadline.
 *
 * `AbortSignal.timeout` rather than a hand-rolled race: a race leaves the request running and
 * the socket open, which at 1Hz over a saturated venue network stacks up.
 */
async function once<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  if (API_BASE === null) return fail('no API configured', true);

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
    });

    const text = await res.text();
    let body: unknown = null;
    try { body = text === '' ? null : JSON.parse(text); } catch { /* handled below */ }

    if (!res.ok) {
      const message = typeof body === 'object' && body !== null
        && 'error' in body && typeof (body as { error: unknown }).error === 'object'
        ? String(((body as { error: { message?: unknown } }).error).message ?? res.status)
        : `HTTP ${res.status}`;
      // A 4xx is the server's considered answer, not a network problem: retrying it just
      // repeats the same rejection and delays telling the cook what is wrong.
      return { ok: false, error: message, offline: res.status >= 500 };
    }

    if (body === null) return fail('empty response');
    return { ok: true, value: body as T };
  } catch (error) {
    const name = (error as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') return fail('timed out', true);
    return fail('network unreachable', true);
  }
}

/**
 * Retried once, and only on a failure that could plausibly differ next time.
 *
 * Reads are retried; writes are not, because a POST that timed out may well have landed and a
 * blind retry puts a second row on a public board. Idempotency keys would fix that properly and
 * are not worth the complexity for a score submission.
 */
async function get<T>(path: string): Promise<ApiResult<T>> {
  const first = await once<T>(path);
  if (first.ok || !first.offline) return first;
  await sleep(RETRY_DELAY_MS);
  return once<T>(path);
}

const post = <T>(path: string, body: unknown): Promise<ApiResult<T>> =>
  once<T>(path, { method: 'POST', body: JSON.stringify(body) });

// ---- Recipes -------------------------------------------------------------------------------

export async function fetchRecipes(query?: string): Promise<ApiResult<readonly Recipe[]>> {
  const suffix = query === undefined || query.trim() === ''
    ? '?limit=50'
    : `?limit=50&q=${encodeURIComponent(query.trim())}`;
  const res = await get<{ recipes: unknown }>(`/api/recipes${suffix}`);
  return res.ok ? { ok: true, value: toRecipes(res.value.recipes) } : res;
}

export async function fetchRecipe(slug: string): Promise<ApiResult<Recipe>> {
  const res = await get<unknown>(`/api/recipes/${encodeURIComponent(slug)}`);
  if (!res.ok) return res;
  const recipe = toRecipe(res.value);
  return recipe === null ? fail('recipe did not parse') : { ok: true, value: recipe };
}

export async function createRecipe(doc: NewRecipeDoc | RecipeDoc): Promise<ApiResult<Recipe>> {
  const res = await post<unknown>('/api/recipes', doc);
  if (!res.ok) return res;
  const recipe = toRecipe(res.value);
  return recipe === null ? fail('server returned a recipe that did not parse') : { ok: true, value: recipe };
}

// ---- Scores --------------------------------------------------------------------------------

export interface SubmittedScore {
  readonly id: string;
  readonly rank: number;
  readonly total: number;
}

export interface BoardEntry {
  readonly rank: number;
  readonly name: string;
  readonly score: number;
  readonly createdAt: string;
}

export interface Board {
  readonly entries: readonly BoardEntry[];
  readonly total: number;
}

export function submitScore(input: {
  name: string;
  /** 0..100. The app scores 0..1; convert at the call site, not here. */
  score: number;
  metrics?: Record<string, number | string | boolean>;
  recipeSlug?: string;
}): Promise<ApiResult<SubmittedScore>> {
  return post<SubmittedScore>('/api/scores', input);
}

export async function fetchLeaderboard(limit = 20): Promise<ApiResult<Board>> {
  const res = await get<{ entries?: unknown; total?: unknown }>(`/api/leaderboard?limit=${limit}`);
  if (!res.ok) return res;

  // Narrowed rather than cast. These rows were typed by strangers and are about to be shown to
  // a room; a row missing a name must not render as `undefined` on the booth monitor.
  const rows = Array.isArray(res.value.entries) ? (res.value.entries as unknown[]) : [];
  const entries: BoardEntry[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r['name'] !== 'string') continue;
    if (typeof r['score'] !== 'number' || !Number.isFinite(r['score'])) continue;
    if (typeof r['rank'] !== 'number' || !Number.isFinite(r['rank'])) continue;
    entries.push({
      rank: r['rank'],
      name: r['name'],
      score: r['score'],
      createdAt: typeof r['createdAt'] === 'string' ? r['createdAt'] : '',
    });
  }

  return {
    ok: true,
    value: { entries, total: typeof res.value.total === 'number' ? res.value.total : entries.length },
  };
}

export async function health(): Promise<boolean> {
  const res = await once<{ ok?: unknown }>('/api/health');
  return res.ok && res.value.ok === true;
}
