/**
 * Screen 2E -- the competitive round, over the real board.
 *
 * Built at the artboard's 1440x810: the 300px timer card centred at top 104, the three stat
 * tiles at left 352 / bottom 44, the 420px leaderboard at right 48.
 *
 * THE DEPARTURE IS THE SAME AS 2A'S AND IT IS THE POINT OF THE PROJECT. The document draws a
 * wooden board at left 352 / bottom 110, 520x170, with a carrot on it, three rectangles
 * standing in for cut pieces, and a knife swinging above on `idy-chop`. That is a picture of
 * the thing this round is supposed to measure. Here the passthrough camera fills the window,
 * that rectangle is left clear as a framing guide for the real board, and the numbers come off
 * what the camera actually sees.
 *
 * WHAT IS MEASURED, AND WHY IT IS NOT MILLIMETRES.
 *
 * Each blob's oriented rect gives a short side, and the short side of a slice is its thickness.
 * Turning that into millimetres needs pixels-per-millimetre, which needs a calibration step --
 * and ninety seconds with a judge wearing the headset is the worst possible place for one. So
 * the round scores EVENNESS, which is scale-free: the coefficient of variation cancels the
 * unknown scale out entirely. "94% even" is a true statement about the cutting; a millimetre
 * figure off an uncalibrated camera would not be.
 *
 * The artboard's third tile is "Knuckle guard: SAFE". That needs 26 hand joints from an
 * immersive WebXR session, which a browser tab does not get, so a safety light here would be
 * wired to nothing -- worse than no light, because somebody would trust it. The tile reads
 * pieces in shot instead.
 */

import { rankFor } from '../../core/rank.js';
import type { AppContext, Panel, RouteParams, RoundResult } from '../app.js';
import { addToBoard, rankBoard, type RoundEntry } from '../board.js';
import { button, fill, h } from '../dom.js';
import { mountGuidance, type Guide } from '../guidance.js';
import { createRail } from '../rail.js';
import { createStage } from '../stage.js';
import { mountPassthrough } from '../passthroughView.js';
import { AnalysisLoop, evenness, loadVision, type Analysis } from '../vision.js';

const ROUND_SECONDS = 90;
/** Pieces in a round that count as a full pace score. A brunoise of one carrot is about this. */
const PACE_TARGET = 24;
/** Widths kept for the evenness figure. */
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

/** The document's three tile tints, in order. */
const TILE: readonly { background: string; label: string }[] = [
  { background: '#CDE6C7', label: '#2F5A26' },
  { background: '#FBE3A0', label: '#8A6A2E' },
  { background: '#F9C7BE', label: '#9A4E44' },
];

export function cuttingPanel(ctx: AppContext, params: RouteParams): Panel {
  const practice = params.practice === true;
  const recipe = ctx.state.recipes.find((r) => r.id === params.recipeId) ?? null;

  const pass = mountPassthrough({ scrim: true, fault: false });
  const stage = createStage({ width: 1440, height: 810 });

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

  /**
   * The chef. Answers "I am stuck" through speech, a pin over the real board and the card on
   * the left, and speaks up on its own when a fault has stood long enough to be real.
   *
   * Built here rather than inside the panel's own logic because it owns its state across the
   * whole screen, including between rounds -- a correction the cook has already been given
   * should not be repeated because they pressed "run it again".
   */
  const guide: Guide = mountGuidance({
    recipe,
    counter: ctx.state.pantry.items.map((item) => ({ name: item.ingredient, count: item.count })),
    round: () => ({
      evenness: phase === 'running' ? evenness(widths) : ctx.state.lastRound?.evenness ?? null,
      pieces: phase === 'running' ? peakPieces : ctx.state.lastRound?.pieces ?? peakPieces,
      secondsLeft: practice || phase !== 'running' ? null : Math.max(0, remaining),
    }),
    cameraLive: () => pass.status() === 'live',
    video: () => pass.video(),
  });

  // ---------------------------------------------------------------- pieces

  const clock = h('div', { class: 'k-timer__clock', text: formatClock(ROUND_SECONDS) });
  const clockLabel = h('div', { class: 'k-timer__label', text: 'Time left' });
  const clockFill = h('div', { class: 'k-timer__fill', style: { width: '100%' } });
  const camPill = h('div', { class: 'k-cam', text: 'Camera' });
  const boardGuide = h(
    'div',
    { class: 'k-board' },
    h('div', { class: 'k-board__hint', text: 'Put your board in this frame' }),
  );

  const statValues = [
    h('div', { class: 'k-stat__value', text: '—' }),
    h('div', { class: 'k-stat__value', text: '—' }),
    h('div', { class: 'k-stat__value', text: '0' }),
  ];

  const statTile = (index: number, label: string): HTMLElement => {
    const tint = TILE[index] ?? TILE[0]!;
    return h(
      'div',
      { class: 'k-stat', style: { background: tint.background } },
      h('div', { class: 'k-stat__label', text: label, style: { color: tint.label } }),
      statValues[index]!,
    );
  };

  const rows = h('div', { class: 'k-lb__rows' });
  const call = h('div', { class: 'k-lb__call' });
  const rule = h('div', {
    class: 'k-lb__rule',
    text: 'Score is evenness first, speed second. A round that measures nothing does not post.',
  });

  const nameInput = h('input', {
    class: 'k-name',
    attrs: { type: 'text', maxlength: '16', 'aria-label': 'Your name on the board', autocomplete: 'off' },
  });
  nameInput.value = ctx.state.playerName;
  nameInput.addEventListener('change', () => {
    const name = nameInput.value.trim();
    ctx.setState({ playerName: name === '' ? 'You' : name });
  });

  const goButton = button('k-act k-act--go', () => primaryAction(), 'Start');
  const postButton = button('k-act k-act--post', () => post(), 'Post it');

  // ---------------------------------------------------------------- round

  function primaryAction(): void {
    if (phase === 'running') finish();
    else if (phase === 'done') reset();
    else void begin();
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

    timer = setInterval(() => {
      elapsed += 1;
      if (!practice) {
        remaining -= 1;
        if (remaining <= 0) {
          finish();
          return;
        }
      }
      paint();
    }, 1000);

    paint();
  }

  function onAnalysis(analysis: Analysis): void {
    live = analysis;
    // Synchronous and cheap: it folds the frame into the coaching session and asks two pure
    // functions whether anything is worth saying. Nothing here awaits.
    guide.observe(analysis);
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
    ctx.setState({
      lastRound: {
        evenness: even ?? 0,
        pieces: peakPieces,
        seconds: practice ? elapsed : ROUND_SECONDS - Math.max(0, remaining),
        total: even === null ? 0 : scoreOf(even, peakPieces),
        measurements: widths.length,
      } satisfies RoundResult,
    });
    paint();
  }

  function post(): void {
    const round = ctx.state.lastRound;
    if (round === null || practice || posted !== null) return;
    // A round that measured nothing has no score, only a zero. Putting that on the board leaves
    // a row that looks like a terrible attempt when it was a camera that never saw the board.
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
    // The chef's pin survives the round ending and the measurement tags do not: an answer the
    // cook asked for should not vanish because the clock ran out mid-sentence.
    const pin = guide.marker();
    if (live === null || phase !== 'running') {
      pass.setOverlay(pin === null ? [] : [pin]);
      return;
    }
    pass.setOverlay([
      ...live.detections.slice(0, 12).map((detection) => ({
        x: detection.x,
        y: detection.y,
        node: h('span', { class: 'tag', text: `${Math.round(detection.minorPx)}px` }),
      })),
      ...(pin === null ? [] : [pin]),
    ]);
  }

  function paintBoard(): void {
    const ranked = rankBoard(ctx.state.board);

    fill(
      rows,
      ...ranked.slice(0, 8).map((entry, index) => {
        const mine = posted !== null && entry.at === posted.at && entry.name === posted.name;
        return h(
          'div',
          { class: `k-row${mine ? ' is-mine' : ''}` },
          h('span', { class: 'k-row__pos', text: String(index + 1).padStart(2, '0') }),
          h(
            'div',
            { class: 'k-row__body' },
            h('div', { class: 'k-row__name', text: entry.name }),
            h('div', {
              class: 'k-row__tag',
              text: `${rankFor(entry.total).title} · ${entry.pieces} pieces`,
            }),
          ),
          h('span', { class: 'k-row__score', text: points(entry.total) }),
        );
      }),
    );

    const round = ctx.state.lastRound;
    if (posted !== null) {
      const place = ranked.findIndex((e) => e.at === posted?.at && e.name === posted?.name) + 1;
      call.textContent = `You are ${ordinal(place)} of ${ranked.length}`;
      return;
    }
    if (round !== null && round.measurements >= MIN_MEASUREMENTS) {
      const target = ranked.find((entry) => entry.total > round.total);
      call.textContent = target === undefined
        ? 'Best round on this board'
        : `Beat ${points(target.total)} to pass ${target.name}`;
      return;
    }
    const top = ranked[0];
    call.textContent = top === undefined
      ? 'First round sets the mark'
      : `Beat ${points(top.total)} to take first`;
  }

  function paint(): void {
    const round = ctx.state.lastRound;
    const liveEven = phase === 'running' ? evenness(widths) : round?.evenness ?? null;
    const pieces = phase === 'running' ? peakPieces : round?.pieces ?? peakPieces;
    const seconds = phase === 'running' ? Math.max(1, elapsed) : round?.seconds ?? elapsed;
    const measured = phase === 'done' ? round?.measurements ?? 0 : widths.length;

    clockLabel.textContent = practice ? 'Practising' : phase === 'done' ? 'Round over' : 'Time left';
    clock.textContent = practice ? formatClock(elapsed) : formatClock(Math.max(0, remaining));
    clockFill.style.width = practice
      ? '100%'
      : `${Math.round((Math.max(0, remaining) / ROUND_SECONDS) * 100)}%`;

    statValues[0]!.textContent = liveEven === null || measured < MIN_MEASUREMENTS
      ? '—'
      : `${Math.round(liveEven * 100)}%`;
    statValues[1]!.textContent = pieces === 0 ? '—' : `${(pieces / Math.max(1, seconds)).toFixed(1)} / sec`;
    statValues[2]!.textContent = String(pieces);

    const camLive = pass.status() === 'live';
    camPill.textContent = camLive ? 'Passthrough live' : `Camera ${pass.status()}`;
    camPill.classList.toggle('is-live', camLive);
    boardGuide.classList.toggle('is-live', camLive);

    goButton.textContent = phase === 'running'
      ? practice ? 'Stop' : 'End round'
      : phase === 'done' ? 'Run it again' : practice ? 'Start practising' : 'Start the round';
    goButton.disabled = !camLive;

    const scoreable = round !== null && round.measurements >= MIN_MEASUREMENTS;
    postButton.disabled = practice || phase !== 'done' || !scoreable || posted !== null;
    postButton.textContent = posted !== null ? 'On the board' : 'Post it';

    rule.textContent = !camLive
      ? 'The round needs the camera. Nothing can be measured without it.'
      : phase === 'ready'
        ? 'Each piece is measured across its short side. The score is how close those are to each other.'
        : phase === 'running'
          ? liveEven === null
            ? 'Cut at least three pieces and leave them in shot.'
            : `${widths.length} measurements so far.`
          : scoreable
            ? `${Math.round((round?.evenness ?? 0) * 100)}% even over ${round?.measurements ?? 0} measurements.`
            : 'Nothing was measured, so there is no score.';

    paintBoard();
    railUpdate();
  }

  // ---------------------------------------------------------------- shell

  const rail = createRail([], () => ctx.back(), 'board');

  function railUpdate(): void {
    rail.update([
      {
        key: 'GRIP',
        label: phase === 'running' ? 'End the round' : 'Hold the knife',
        accent: true,
        shortcut: 'shift',
        disabled: pass.status() !== 'live',
        onPress: () => primaryAction(),
      },
      {
        key: 'A',
        label: 'Submit the board',
        disabled: postButton.disabled,
        onPress: () => post(),
      },
      { key: 'X', label: 'Unsure — ask the chef', shortcut: 'x', onPress: () => guide.ask(null) },
      { key: 'Y', label: 'Quit the round', onPress: () => ctx.go('title') },
      { key: '☰', label: 'Menu', end: true, shortcut: 'm', onPress: () => ctx.back() },
    ]);
  }

  stage.board.classList.add('b2', 'b2--live');
  stage.board.append(
    h(
      'div',
      { class: 'k-head' },
      h('div', { class: 'k-title', text: practice ? 'Knife practice' : 'Competitive cutting' }),
      h('div', {
        class: 'k-round',
        text: recipe === null ? 'Free round · 90 seconds' : recipe.name,
      }),
    ),
    camPill,
    h(
      'div',
      { class: 'k-timer' },
      clockLabel,
      clock,
      h('div', { class: 'k-timer__meter' }, clockFill),
    ),
    boardGuide,
    guide.node,
    h(
      'div',
      { class: 'k-stats' },
      statTile(0, 'Even cuts'),
      statTile(1, 'Pace'),
      statTile(2, 'Pieces in shot'),
    ),
    h(
      'div',
      { class: 'k-board-panel' },
      h(
        'div',
        { class: 'k-lb__head' },
        h('div', { class: 'k-lb__title', text: 'Leaderboard' }),
        h('div', { class: 'k-lb__scope', text: 'This device' }),
      ),
      rows,
      h(
        'div',
        { class: 'k-lb__foot' },
        call,
        rule,
        h('div', { class: 'k-lb__actions' }, goButton, postButton),
        h('div', { class: 'k-name-wrap' }, nameInput),
      ),
    ),
    rail.node,
  );

  const node = h('section', { class: 'screen screen--board cutting' }, pass.node, stage.node);

  // The pin is one of the chef's three channels, and the chef changes it on its own schedule
  // -- an answer landing from the model, an unprompted correction, a pin going stale. The
  // panel owns the overlay, so it has to be told.
  const stopGuiding = guide.onChange(() => paintOverlay());

  const stopWatching = pass.onStatusChange(() => {
    // A camera that drops mid-round ends the round rather than quietly scoring nothing.
    if (pass.status() !== 'live' && phase === 'running') finish();
    paint();
  });

  paint();

  return {
    node,
    destroy: () => {
      loop?.stop();
      if (timer !== null) clearInterval(timer);
      stopGuiding();
      guide.destroy();
      stopWatching();
      pass.destroy();
      stage.destroy();
      rail.destroy();
    },
  };
}

/**
 * The score as the document prints it: four digits with a thousands separator.
 *
 * The underlying number is 0..1 -- 0.7 of evenness plus 0.3 of pace -- and this is a display
 * scale on it, the same way a percentage is. Nothing is invented; 0.94 is 9,400.
 */
const points = (total: number): string => Math.round(total * 10000).toLocaleString('en-US');

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}
