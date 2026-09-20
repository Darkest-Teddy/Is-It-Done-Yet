/**
 * The life of each problem across a session: when it appeared, and when the cook cleared it.
 *
 * This is what turns the live coach into a report. The summary is not a second analysis of the
 * finished board -- it is this log, which is the same `Deficit` values the cook was shown while
 * cooking, with times attached. A separate end-of-session analysis could reach a different
 * conclusion from the live one, and a report that contradicts the coaching destroys trust in
 * both halves.
 *
 * Spans open instantly and close only after the problem has stayed gone for a grace period.
 * That asymmetry is the same one `SafetyDebouncer` uses and it is here for the same reason:
 * per-frame segmentation flickers, and without it a single dropped frame ends a span and opens
 * an identical one a moment later, turning "you never added the tomato" into forty separate
 * two-second problems in the report.
 */

import type { Deficit } from './deficit.js';

/** One problem's life. Closed spans carry a `clearedMs`; open ones do not. */
export interface DeficitSpan {
  readonly kind: string;
  readonly ingredient: string | null;
  readonly instruction: string;
  readonly severity: string;
  readonly firstSeenMs: number;
  /** Null when it was still present at the end of the session. */
  readonly clearedMs: number | null;
}

interface OpenSpan extends DeficitSpan {
  readonly key: string;
  /** Last observation that actually contained this problem. */
  readonly lastSeenMs: number;
}

export interface DeficitLog {
  readonly spans: readonly OpenSpan[];
  /** How long a problem must stay absent before its span is closed. */
  readonly clearGraceMs: number;
}

/**
 * Two deficits are the same ongoing problem if they are the same kind about the same ingredient.
 *
 * Deliberately excludes the measured value: a cucumber drifting from 8mm to 7mm is one problem
 * being partially fixed, not one problem ending and another starting. Keying on the number would
 * make the report count every small correction as a fresh mistake.
 */
export function deficitKey(d: Deficit): string {
  return `${d.kind}:${d.ingredient ?? ''}`;
}

/** TUNED, not sourced -- long enough to ride out segmentation dropout, short enough to feel live. */
export const DEFAULT_CLEAR_GRACE_MS = 1500;

export function emptyLog(clearGraceMs: number = DEFAULT_CLEAR_GRACE_MS): DeficitLog {
  return { spans: [], clearGraceMs };
}

/**
 * Folds one observation into the log.
 *
 * Pure: returns a new log rather than mutating, so a session can be replayed from recorded
 * observations and produce byte-identical spans -- which is what makes the report testable
 * without a camera.
 */
export function observe(
  log: DeficitLog,
  nowMs: number,
  deficits: readonly Deficit[],
): DeficitLog {
  const present = new Map<string, Deficit>();
  for (const d of deficits) present.set(deficitKey(d), d);

  const spans: OpenSpan[] = [];
  const stillOpen = new Set<string>();

  for (const span of log.spans) {
    if (span.clearedMs !== null) {
      spans.push(span);
      continue;
    }

    const current = present.get(span.key);
    if (current !== undefined) {
      stillOpen.add(span.key);
      // Instruction refreshes so the report quotes the most recent measurement rather than the
      // first one, which is usually the least representative.
      spans.push({ ...span, instruction: current.instruction, lastSeenMs: nowMs });
      continue;
    }

    // Absent this observation. Close only once it has been gone longer than the grace period,
    // and close it at the moment it was last actually seen rather than now -- otherwise every
    // span is reported as lasting an extra grace period that the cook did not experience.
    if (nowMs - span.lastSeenMs >= log.clearGraceMs) {
      spans.push({ ...span, clearedMs: span.lastSeenMs });
    } else {
      stillOpen.add(span.key);
      spans.push(span);
    }
  }

  for (const [key, d] of present) {
    if (stillOpen.has(key)) continue;
    spans.push({
      key,
      kind: d.kind,
      ingredient: d.ingredient,
      instruction: d.instruction,
      severity: d.severity,
      firstSeenMs: nowMs,
      lastSeenMs: nowMs,
      clearedMs: null,
    });
  }

  return { ...log, spans };
}

/**
 * The session's spans, oldest first, with anything still open left open.
 *
 * An unfixed problem keeps `clearedMs: null` rather than being closed at the end time, because
 * "still wrong when you served it" and "fixed right at the buzzer" are different outcomes and
 * the report should be able to tell them apart.
 */
export function finalize(log: DeficitLog): readonly DeficitSpan[] {
  return log.spans
    .map(({ key: _key, lastSeenMs: _lastSeenMs, ...span }) => span)
    .sort((a, b) => a.firstSeenMs - b.firstSeenMs);
}

/** Problems still present at the end. The headline of any honest report. */
export function unresolved(log: DeficitLog): readonly DeficitSpan[] {
  return finalize(log).filter((s) => s.clearedMs === null);
}
