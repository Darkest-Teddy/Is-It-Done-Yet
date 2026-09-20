/**
 * Screen 2E -- the competitive round, over the real board.
 *
 * The artboard drew a wooden board, a carrot and three rectangles standing in for slices, with
 * a knife swinging on a loop. This is the other screen where the stand-in was the whole point:
 * it sits over the headset's passthrough camera, and the numbers come off the board you are
 * actually cutting on.
 *
 * WHAT IS MEASURED, AND WHY IT IS NOT MILLIMETRES.
 *
 * Every frame is segmented, each blob's oriented rect gives a short side, and the short side of
 * a slice is its thickness. Turning that into millimetres needs pixels-per-millimetre, which
 * needs a calibration step against something of known width -- and a ninety-second round with a
 * judge holding the headset is the worst possible place to put a calibration step.
 *
 * So the round scores EVENNESS, which is scale-free: the coefficient of variation of the
 * measured widths cancels the unknown scale out entirely. Ten slices all forty pixels across
 * score exactly what ten slices all four millimetres across would. "94% even" is a true
 * statement about your cutting; quoting a millimetre figure off an uncalibrated camera would
 * not be, and an engineer judge asks about that in the first thirty seconds.
 *
 * The artboard's third tile was "Knuckle guard: SAFE". There is no hand tracking in a browser
 * tab -- that needs 26 joints from an immersive WebXR session -- so a safety indicator here
 * would be a green light wired to nothing, which is worse than no light at all. The tile shows
 * pieces on the board instead.
 */

import { rankFor } from '../../core/rank.js';
import type { AppContext, Panel, RouteParams, RoundResult } from '../app.js';
import { addToBoard, rankBoard, type RoundEntry } from '../board.js';
import { art, button, fill, h } from '../dom.js';
import { designRem, heroSize, heroUrl } from '../art.js';
import { createRail } from '../rail.js';
import { mountPassthrough } from '../passthroughView.js';
import { AnalysisLoop, evenness, loadVision, type Analysis } from '../vision.js';

const ROUND_SECONDS = 90;
/** Pieces in the round that count as a full pace score. A brunoise of one carrot is about this. */
const PACE_TARGET = 24;
/** Widths kept for the evenness figure. Enough to be stable, short enough to follow the round. */
const SAMPLE_CAP = 400;
/** Fewer than this and there is no spread to speak of, so there is no score either. */
const MIN_MEASUREMENTS = 3;

type Phase = 'ready' | 'running' | 'done';

/**
 * Evenness carries most of the score because it is the thing being taught. Speed is worth
 * something -- a round you cannot finish is not a good round -- but a fast pile of wedges
 * should never beat a careful line of identical slices.
 */
const scoreOf = (even: number, pieces: number): number =>
  0.7 * even + 0.3 * Math.min(1, pieces / PACE_TARGET);

export function cuttingPanel(ctx: AppContext, params: RouteParams): Panel {
  const practice = params.practice === true;
  const recipe = ctx.state.recipes.find((r) => r.id === params.recipeId) ?? null;

  const pass = mountPassthrough({ scrim: true });

  let phase: Phase = 'ready';
  let loop: AnalysisLoop | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let remaining = ROUND_SECONDS;
  let elapsed = 0;
  let widths: number[] = [];
  let peakPieces = 0;
  let live: Analysis | null = null;
  let posted: RoundEntry | null = null;
  let visionReady = false;

  // ---------------------------------------------------------------- structure

  const clock = h('div', { class: 'display d-hero tabular cut__clock', text: formatClock(ROUND_SECONDS) });
  const clockFill = h('div', { class: 'meter__fill', style: { width: '100%' } });
  const clockLabel = h('div', { class: 'label', text: 'Time left', style: { color: 'var(--brown)' } });

  const evenValue = h('div', { class: 'display d-lg tabular', text: '—' });
  const paceValue = h('div', { class: 'display d-lg tabular', text: '—' });
  const piecesValue = h('div', { class: 'display d-lg tabular', text: '0' });
  const hint = h('p', { class: 'note cut__hint' });

  const boardRows = h('div', { class: 'cut__board-rows scroll' });
  const boardNote = h('p', { class: 'note' });

  const nameInput = h('input', {
    class: 'cut__name',
    attrs: { type: 'text', maxlength: '16', 'aria-label': 'Your name on the board', autocomplete: 'off' },
  });
  nameInput.value = ctx.state.playerName;
  nameInput.addEventListener('change', () => {
    const name = nameInput.value.trim();
    ctx.setState({ playerName: name === '' ? 'You' : name });
  });

  const primary = button('btn btn--hot btn--big cut__primary', () => primaryAction(), 'Start the round');
  const submit = button('btn btn--sun btn--big', () => post(), 'Put it on the board');
  submit.disabled = true;

  function statTile(label: string, value: HTMLElement, tint: string): HTMLElement {
    return h(
      'div',
      { class: 'card cut__stat', style: { background: tint } },
      h('span', { class: 'label', text: label, style: { color: 'var(--brown)' } }),
      value,
    );
  }

  // ---------------------------------------------------------------- round

  function primaryAction(): void {
    if (phase === 'running') {
      finish();
      return;
    }
    void begin();
  }

  async function begin(): Promise<void> {
    visionReady = await loadVision();
    const video = pass.video();

    if (!visionReady || video === null) {
      paint();
      return;
    }

    phase = 'running';
    widths = [];
    peakPieces = 0;
    elapsed = 0;
    remaining = ROUND_SECONDS;
    posted = null;

    loop = new AnalysisLoop(video, onAnalysis, 200, 420);
    loop.start();

    if (!practice) {
      timer = setInterval(() => {
        remaining -= 1;
        elapsed += 1;
        if (remaining <= 0) finish();
        else paint();
      }, 1000);
    } else {
      timer = setInterval(() => {
        elapsed += 1;
        paint();
      }, 1000);
    }

    paint();
  }

  function onAnalysis(analysis: Analysis): void {
    live = analysis;
    if (phase === 'running') {
      for (const detection of analysis.detections) widths.push(detection.minorPx);
      if (widths.length > SAMPLE_CAP) widths = widths.slice(-SAMPLE_CAP);
      peakPieces = Math.max(peakPieces, analysis.detections.length);
    }
    paintOverlay();
    paint();
  }

  function finish(): void {
    if (phase !== 'running') return;
    phase = 'done';
    loop?.stop();
    loop = null;
    if (timer !== null) clearInterval(timer);
    timer = null;

    const even = evenness(widths);
    const result: RoundResult = {
      evenness: even ?? 0,
      pieces: peakPieces,
      seconds: practice ? elapsed : ROUND_SECONDS - Math.max(0, remaining),
      total: even === null ? 0 : scoreOf(even, peakPieces),
      measurements: widths.length,
    };
    ctx.setState({ lastRound: result });
    paint();
  }

  function post(): void {
    const round = ctx.state.lastRound;
    if (round === null || practice || posted !== null) return;
    // A round that measured nothing has no score, only a zero. Putting that on the board would
    // leave a row that looks like a terrible attempt when it was really a camera that never saw
    // the board.
    if (round.measurements < MIN_MEASUREMENTS) return;

    const entry: RoundEntry = {
      name: ctx.state.playerName.trim() === '' ? 'You' : ctx.state.playerName.trim(),
      total: round.total,
      evenness: round.evenness,
      pieces: round.pieces,
      seconds: round.seconds,
      at: Date.now(),
    };
    posted = entry;
    ctx.setState({
      board: addToBoard(ctx.state.board, entry),
      best: Math.max(ctx.state.best, entry.total),
    });
    paint();
  }

  function reset(): void {
    phase = 'ready';
    widths = [];
    peakPieces = 0;
    elapsed = 0;
    remaining = ROUND_SECONDS;
    posted = null;
    ctx.setState({ lastRound: null });
    paint();
  }

  // ---------------------------------------------------------------- painting

  function paintOverlay(): void {
    if (live === null || phase === 'done') {
      pass.setOverlay([]);
      return;
    }
    pass.setOverlay(
      live.detections.slice(0, 12).map((detection) => ({
        x: detection.x,
        y: detection.y,
        node: h('span', { class: 'tag', text: `${Math.round(detection.minorPx)}px` }),
      })),
    );
  }

  function paintBoard(): void {
    const ranked = rankBoard(ctx.state.board);

    fill(
      boardRows,
      ...ranked.slice(0, 8).map((entry, index) => {
        const mine = posted !== null && entry.at === posted.at && entry.name === posted.name;
        return h(
          'div',
          { class: `cut__board-row${mine ? ' is-mine' : ''}` },
          h('span', { class: 'display d-sm cut__pos tabular', text: String(index + 1) }),
          h('span', { class: 'cut__badge', text: rankFor(entry.total).icon }),
          h(
            'div',
            { class: 'stack grow' },
            h('span', { class: 'cut__who truncate', text: entry.name }),
            h('span', {
              class: 'cut__detail',
              text: `${entry.pieces} pieces · ${Math.round(entry.evenness * 100)}% even`,
            }),
          ),
          h('span', { class: 'display d-sm tabular', text: entry.total.toFixed(2) }),
        );
      }),
    );

    const round = ctx.state.lastRound;
    if (posted !== null) {
      const place = ranked.findIndex((e) => e.at === posted?.at && e.name === posted?.name) + 1;
      boardNote.textContent = `You are ${ordinal(place)} of ${ranked.length} on this board.`;
      return;
    }
    if (round !== null && round.measurements >= MIN_MEASUREMENTS) {
      const target = ranked.find((entry) => entry.total > round.total);
      boardNote.textContent = target === undefined
        ? 'That is the best round on this board.'
        : `${(target.total - round.total).toFixed(2)} short of ${target.name}.`;
      return;
    }
    const top = ranked[0];
    boardNote.textContent = top === undefined
      ? 'Nothing on the board yet. First round sets the mark.'
      : `${top.name} leads with ${top.total.toFixed(2)}. Evenness first, speed second.`;
  }

  function paint(): void {
    const round = ctx.state.lastRound;
    const liveEven = phase === 'running' ? evenness(widths) : round?.evenness ?? null;
    const pieces = phase === 'running' ? peakPieces : round?.pieces ?? peakPieces;
    const seconds = phase === 'running' ? Math.max(1, elapsed) : round?.seconds ?? elapsed;

    clockLabel.textContent = practice ? 'Practising' : phase === 'done' ? 'Round over' : 'Time left';
    clock.textContent = practice ? formatClock(elapsed) : formatClock(Math.max(0, remaining));
    clockFill.style.width = practice
      ? '100%'
      : `${Math.round((Math.max(0, remaining) / ROUND_SECONDS) * 100)}%`;

    // '—' rather than '0%' when nothing was measured: zero evenness is a real, terrible score,
    // and printing it for "the camera saw nothing" is the wrong answer to a different question.
    const measured = phase === 'done' ? (round?.measurements ?? 0) : widths.length;
    evenValue.textContent = liveEven === null || measured < MIN_MEASUREMENTS
      ? '—'
      : `${Math.round(liveEven * 100)}%`;
    paceValue.textContent = pieces === 0 ? '—' : `${(pieces / Math.max(1, seconds)).toFixed(2)}/s`;
    piecesValue.textContent = String(pieces);

    primary.textContent = phase === 'running'
      ? practice ? 'Stop practising' : 'End the round early'
      : phase === 'done'
        ? 'Run it again'
        : practice ? 'Start practising' : 'Start the round';

    if (phase === 'done') primary.onclick = () => reset();
    else primary.onclick = () => primaryAction();

    const camera = pass.status();
    primary.disabled = camera !== 'live';
    const scoreable = round !== null && round.measurements >= MIN_MEASUREMENTS;
    submit.disabled = practice || phase !== 'done' || !scoreable || posted !== null;
    submit.textContent = posted !== null ? 'On the board' : 'Put it on the board';

    hint.textContent = camera !== 'live'
      ? 'The round needs the camera. Nothing can be measured without it.'
      : !visionReady && phase !== 'ready'
        ? 'The vision engine did not load, so nothing can be measured this round.'
        : phase === 'ready'
          ? 'Put the board in view, then cut. Each piece is measured across its short side, and'
            + ' the score is how close those measurements are to each other.'
          : phase === 'running'
            ? liveEven === null
              ? 'Cut at least three pieces and leave them in shot — evenness needs something to compare.'
              : `${widths.length} measurements so far.`
            : round === null || round.measurements < MIN_MEASUREMENTS
              ? 'Nothing was measured, so there is no score. Keep the cut pieces in shot and run it again.'
              : `${Math.round(round.evenness * 100)}% even over ${round.measurements} measurements.`;

    paintBoard();
    railUpdate();
  }

  // ---------------------------------------------------------------- shell

  const rail = createRail([], () => ctx.back());

  function railUpdate(): void {
    rail.update([
      {
        key: 'GRIP',
        label: phase === 'running' ? 'End the round' : 'Start the round',
        accent: true,
        shortcut: 'shift',
        disabled: pass.status() !== 'live',
        onPress: () => primaryAction(),
      },
      {
        key: 'A',
        label: 'Put it on the board',
        disabled: practice || phase !== 'done' || posted !== null
          || (ctx.state.lastRound?.measurements ?? 0) < MIN_MEASUREMENTS,
        onPress: () => post(),
      },
      { key: 'Y', label: 'Quit the round', onPress: () => ctx.go('title') },
      { key: '☰', label: 'Back', end: true, shortcut: 'm', onPress: () => ctx.back() },
    ]);
  }

  const node = h(
    'section',
    { class: 'screen cut' },
    pass.node,
    h(
      'header',
      { class: 'screen__head cut__head' },
      h('h1', { class: 'display d-lg cut__title', text: practice ? 'Knife practice' : 'Competitive cutting' }),
      h('span', {
        class: 'pill pill--hot pill--display',
        text: recipe === null ? 'Free round' : recipe.name,
      }),
      h('span', { class: 'pill cut__cam', text: 'camera' }),
    ),
    h(
      'div',
      { class: 'screen__body cut__body' },
      h(
        'div',
        { class: 'stack grow cut__left' },
        h(
          'div',
          { class: 'card cut__clock-card' },
          clockLabel,
          clock,
          h('div', { class: 'meter cut__clock-meter' }, clockFill),
        ),
        h(
          'div',
          { class: 'cut__stats' },
          statTile('Even cuts', evenValue, 'var(--leaf)'),
          statTile('Pace', paceValue, 'var(--yellow-soft)'),
          statTile('Pieces in shot', piecesValue, 'var(--pink)'),
        ),
        h('div', { class: 'card cut__controls' }, hint, h('div', { class: 'row cut__control-row' }, primary)),
      ),
      h(
        'div',
        { class: 'card cut__board' },
        h(
          'div',
          { class: 'row cut__board-head' },
          h('h2', { class: 'display d-md grow', text: 'Leaderboard' }),
          h('span', { class: 'pill', text: 'This device' }),
        ),
        boardRows,
        h('hr', { class: 'divider' }),
        boardNote,
        h(
          'div',
          { class: 'cut__post' },
          h('div', { class: 'cut__name-wrap' }, art(heroUrl('carrot'), heroSize('carrot', designRem(36))), nameInput),
          submit,
        ),
      ),
    ),
    rail.node,
  );

  function onCameraChange(): void {
    const el = node.querySelector('.cut__cam');
    if (el instanceof HTMLElement) {
      el.textContent = pass.status() === 'live' ? 'Passthrough live' : `Camera ${pass.status()}`;
      el.classList.toggle('pill--leaf', pass.status() === 'live');
    }
    // A camera that drops mid-round ends the round rather than quietly scoring nothing.
    if (pass.status() !== 'live' && phase === 'running') finish();
    paint();
  }

  const stopWatching = pass.onStatusChange(onCameraChange);

  // Called once as well as on change: the camera is often ALREADY live by the time this screen
  // mounts (the loading screen opened it), in which case no change event ever arrives and the
  // pill would sit on its placeholder text forever.
  onCameraChange();

  return {
    node,
    destroy: () => {
      loop?.stop();
      if (timer !== null) clearInterval(timer);
      stopWatching();
      pass.destroy();
      rail.destroy();
    },
  };
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}
