/**
 * In-cooking guidance: one answer, three channels, two triggers, and a chef that speaks up.
 *
 * Everything that DECIDES anything is somewhere else and is pure:
 *
 *   `core/voice/intent.ts`    does this utterance mean "I am stuck"
 *   `core/voice/guidance.ts`  what the answer is, and how it degrades with no model
 *   `core/voice/nag.ts`       whether an unprompted correction is worth making
 *   `core/deficit.ts`         what is actually wrong with the board
 *   `core/timeline.ts`        whether it has persisted long enough to be real
 *   `app/session.ts`          holds those two together across a session
 *
 * What is left here is what genuinely needs a browser: a microphone, a speaker, three
 * renderers, a clock, and a network call with a timeout on it. That split is why the whole
 * decision layer can be proved from a terminal and the demo can be rehearsed on a plane.
 *
 * THE THREE CHANNELS COME FROM ONE `Guidance`. `present` is the only function that writes to
 * any of them, so the spoken line, the pin over the real board, and the panel text cannot
 * describe two different pieces of advice. See the header of `core/voice/guidance.ts` for why
 * that mattered enough to enforce structurally.
 *
 * THE ASKED PATH USES THE MODEL. THE UNPROMPTED PATH DOES NOT, and this is a deliberate
 * asymmetry rather than an omission. When the cook asks, a slow or wrong answer costs them a
 * few seconds and they are already looking at the panel. When the chef interrupts, it is
 * spending their attention without being invited, and it had better be right -- so an
 * interruption is only ever the deficit engine's own instruction, which is derived from a
 * measurement rather than from a model's reading of a scene description. A model that decides
 * unprompted that somebody has made a mistake is the single most expensive failure available
 * to this feature, and the cheapest way not to have it is not to ask.
 *
 * NOTHING HERE AWAITS INSIDE A FRAME. `observe` is called from the existing analysis loop,
 * which is already self-throttling, and does only synchronous folding. Every network call and
 * every OCR read is fire-and-forget with a timeout.
 */

import { askQwen, configFromEnv, type QwenConfig } from '../ai/qwen.js';
import { createChef, speechRelayFromEnv } from '../audio/chef.js';
import { CoachSession } from '../app/session.js';
import type { Piece } from '../core/board.js';
import {
  ACKNOWLEDGEMENT,
  describeContext,
  EMPTY_CONTEXT,
  GUIDANCE_SYSTEM,
  localGuidance,
  observationConfidence,
  openingMove,
  parseModelGuidance,
  stuckIntent,
  type CookContext,
  type CountedItem,
  type Guidance,
} from '../core/voice/guidance.js';
import { mutedPolicy, policyForIntensity, type NagPolicy } from '../core/voice/nag.js';
import type { Recipe } from '../core/recipe.js';
import { processState } from '../core/steps.js';
import { button, fill, h } from './dom.js';
import type { OverlayMarker } from './passthroughView.js';
import type { Analysis } from './vision.js';
import { bestProvider, type SpeechProvider } from '../voice/stt.js';

/** How long a pin stays over the board before it stops being current and starts being litter. */
export const OVERLAY_HOLD_MS = 14_000;

/**
 * Where the pin sits, in FRAME coordinates (0..1 across and down).
 *
 * Just above the artboard's board guide, which is the rectangle the cook is asked to put the
 * real board inside. Over the board itself would cover the thing they are cutting; anywhere
 * else and it stops being anchored to anything. TUNED against the 1440x810 layout -- the guide
 * sits at left 352 / bottom 110, 520x170, so its top edge is a little over halfway down.
 */
export const DEFAULT_ANCHOR = { x: 0.425, y: 0.58 } as const;

/** How often the autonomous watch is allowed to even consider speaking. */
const WATCH_INTERVAL_MS = 1000;

/** Identical finals inside this window are one utterance, not two. Mirrors `heardHandler`. */
const REPEAT_WINDOW_MS = 1500;

export type Intensity = 'off' | 'gentle' | 'full';

export interface RoundSnapshot {
  readonly evenness: number | null;
  readonly pieces: number;
  readonly secondsLeft: number | null;
}

export interface GuidanceOptions {
  /** Null in the free round. Without a recipe there is nothing to be behind on. */
  readonly recipe: Recipe | null;
  /** What the counter scan found the cook has available. */
  readonly counter: readonly CountedItem[];
  readonly round: () => RoundSnapshot;
  readonly cameraLive: () => boolean;
  /** Full-resolution frame source for the on-demand OCR read. Null when the camera is down. */
  readonly video: () => HTMLVideoElement | null;
  readonly anchor?: { readonly x: number; readonly y: number };
}

export interface Guide {
  /** The text channel: a card the caller places on its own artboard. */
  readonly node: HTMLElement;
  /** The AR channel: a marker for `PassthroughView.setOverlay`, or null when nothing is live. */
  marker(): OverlayMarker | null;
  /** Fold one analysed frame in. Synchronous and cheap; safe from the analysis loop. */
  observe(analysis: Analysis, nowMs?: number): void;
  /** The "Unsure" trigger. `question` is the spoken words when there were any. */
  ask(question?: string | null): void;
  /** Fires whenever a channel changed, so the caller can re-place the overlay. */
  onChange(listener: () => void): () => void;
  /** Whether a model is configured at all. Drives the honest label on the panel. */
  readonly hasModel: boolean;
  destroy(): void;
}

/**
 * Detections back into `Piece`s, which is what the coaching engine reasons over.
 *
 * `menu/vision.ts` has already segmented and named these for the on-screen tags. Re-deriving
 * them would be a second chance to disagree about what is on the board, and a tag reading
 * "cucumber" beside a chef insisting there is none is worse than either alone.
 */
function piecesOf(analysis: Analysis): Piece[] {
  return analysis.detections.map((d) => ({
    ingredient: d.ingredient,
    confidence: d.confidence,
    areaPx: d.areaPx,
    // Detections carry a normalised centroid; the board's spread and mixing maths want pixels.
    centroid: { x: d.x * analysis.frameWidth, y: d.y * analysis.frameHeight },
    minorPx: d.minorPx,
  }));
}

/** What the camera last saw, collapsed to "3 x tomato" lines for the prompt and the panel. */
function seenItems(analysis: Analysis | null): CountedItem[] {
  if (analysis === null) return [];
  const counts = new Map<string, number>();
  for (const d of analysis.detections) counts.set(d.ingredient, (counts.get(d.ingredient) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count }));
}

const meanConfidence = (analysis: Analysis | null): number => {
  if (analysis === null || analysis.detections.length === 0) return 0;
  const sum = analysis.detections.reduce((total, d) => total + d.confidence, 0);
  return sum / analysis.detections.length;
};

const POLICY: Readonly<Record<Intensity, () => NagPolicy>> = {
  off: mutedPolicy,
  gentle: () => policyForIntensity(0),
  full: () => policyForIntensity(1),
};

export function mountGuidance(options: GuidanceOptions): Guide {
  const anchor = options.anchor ?? DEFAULT_ANCHOR;
  const model: QwenConfig | null = configFromEnv();

  /**
   * The voice.
   *
   * EVERY LINE THIS PANEL SPEAKS IS NOVEL. The bark bank in `core/barks.ts` is keyed by exact
   * text and holds reactions to cuts; nothing here is in it -- `localGuidance` assembles its
   * sentences from deficit text and Qwen3 writes its own. So the pre-generated tier never fires
   * for this panel, and until the on-demand tier existed the headset heard nothing at all:
   * Quest Browser ships no `speechSynthesis` (DECISIONS.md entry 19), so tier 3 is not there
   * either. That is still why the text channel is not optional decoration -- with no relay
   * configured this panel is exactly as silent on the headset as it was before.
   *
   * The context is a factory rather than an instance because one constructed at mount would be
   * born suspended: browsers hold an AudioContext until a gesture, and the gesture here is the
   * Unsure button. Created on first use, it is created inside that click.
   */
  const chef = createChef(
    () => (typeof AudioContext === 'undefined' ? null : new AudioContext()),
    { speechRelay: speechRelayFromEnv() ?? undefined },
  );

  // The one line here that IS fixed and known in advance, fetched now so it is instant later.
  // `openingMove` says it the moment the button is pressed, specifically to cover the model
  // round trip -- a cover that arrives four seconds late covers nothing. Only when a model is
  // configured, because that is the only case in which it is ever said.
  if (model !== null) chef.prime(ACKNOWLEDGEMENT);

  const session =
    options.recipe === null
      ? null
      : new CoachSession(options.recipe, {
          // Uncalibrated on purpose. DECISIONS.md entry 25: millimetres need a calibration step
          // and ninety seconds with a judge is the worst place for one, so every thickness stays
          // null and no thickness deficit is ever raised here. Counts and proportions still are.
          pxPerMm: null,
          diff: { maxThicknessCvPct: 25, minPiecesForMixCheck: 3 },
        });

  let intensity: Intensity = 'gentle';
  let current: Guidance | null = null;
  let shownAtMs = 0;
  let pending = false;
  /** Guards against a slow model reply landing after the cook has asked something else. */
  let askToken = 0;
  let lastAnalysis: Analysis | null = null;
  let lastAnalysisAtMs = 0;
  let lastWatchMs = 0;
  let cardText: string | null = null;
  let cardStatus = '';
  let lastHeard = '';
  let lastHeardAtMs = 0;
  /** Why the last answer is the one it is. Guidance only. */
  let status = '';
  /**
   * Trouble with the microphone, kept in its OWN slot.
   *
   * These two were one string at first and it was actively misleading: press Unsure, the relay
   * fails, and a beat later the recogniser reports a denied microphone into the same line --
   * so the panel blames the mic for an answer the network lost. Two concerns, two places.
   */
  let listenFault = '';

  let ocr: import('../vision/ocr.js').OcrReader | null = null;

  // Declared up here rather than beside the rest of the card because `changed` can fire before
  // the card is built -- a speech provider that refuses to start reports the error
  // synchronously -- and a temporal dead zone on the first paint would take the screen down.
  const pin = h('div', { class: 'g-pin' });
  const headline = h('div', { class: 'g-line' });
  const body = h('p', { class: 'g-why' });
  const badge = h('span', { class: 'g-badge' });
  const transcript = h('div', { class: 'g-heard' });
  const note = h('div', { class: 'g-note' });
  const cardNote = h('div', { class: 'g-note' });
  const modes = h('div', { class: 'g-modes' });

  const listeners = new Set<() => void>();
  const changed = (): void => {
    paint();
    for (const listener of listeners) listener();
  };

  // ---------------------------------------------------------------- context

  function buildContext(nowMs: number): CookContext {
    const round = options.round();
    const cameraLive = options.cameraLive();
    const state = session?.current ?? null;
    const recipe = options.recipe;

    const process =
      recipe === null
        ? null
        : state?.process ?? processState(recipe, [], new Set());
    const index =
      process === null
        ? -1
        : process.steps.findIndex((s) => s.step.id === process.currentStepId);
    const step = index >= 0 ? process?.steps[index] ?? null : null;
    const next = index >= 0 ? process?.steps[index + 1] ?? null : null;

    return {
      ...EMPTY_CONTEXT,
      recipeName: recipe?.name ?? null,
      recipeDescription: recipe?.description ?? '',
      stepNumber: step === null ? null : index + 1,
      stepCount: process?.totalCount ?? 0,
      stepInstruction: step?.step.instruction ?? null,
      stepVerifiable: step?.step.verifiable ?? null,
      nextStepInstruction: next?.step.instruction ?? null,
      doneCount: process?.doneCount ?? 0,
      counter: options.counter,
      seen: seenItems(lastAnalysis),
      cameraLive,
      faults: (state?.deficits ?? []).map((d) => d.instruction),
      evenness: round.evenness,
      pieces: round.pieces,
      secondsLeft: round.secondsLeft,
      cardText,
      confidence: observationConfidence({
        cameraLive,
        pieceCount: lastAnalysis?.detections.length ?? 0,
        meanPieceConfidence: meanConfidence(lastAnalysis),
        ageMs: lastAnalysis === null ? Number.MAX_SAFE_INTEGER : nowMs - lastAnalysisAtMs,
      }),
    };
  }

  // ---------------------------------------------------------------- channels

  /** The ONLY writer of the three channels. See the header. */
  function present(next: Guidance, speak: string | null, nowMs: number): void {
    current = next;
    shownAtMs = nowMs;
    if (speak !== null && speak !== '') chef.say({ kind: 'improving', line: speak });
    changed();
  }

  // ---------------------------------------------------------------- the asked path

  function ask(question: string | null = null): void {
    const nowMs = Date.now();
    const ctx = buildContext(nowMs);
    const move = openingMove(model !== null, ctx);
    const token = ++askToken;

    pending = move.awaitingModel;
    present(move.shown, move.spoken, nowMs);
    if (!move.awaitingModel || model === null) return;

    // Fire and forget. Rule #10: nothing on the path that answers a human may await a network
    // call, and rule #9: this already has a timeout and a fallback -- `move.shown` is the
    // fallback and it is already on screen.
    void askQwen(model, GUIDANCE_SYSTEM, describeContext(ctx, question))
      .then((raw) => {
        // A reply for a question the cook has already moved on from is noise. Drop it.
        if (token !== askToken) return;
        pending = false;
        if (raw === null) {
          status = `${model.mode === 'relay' ? 'Relay' : model.model} did not answer — local answer stands`;
          // SPEAK THE LOCAL ANSWER, do not merely leave it on screen. The chef has already said
          // "let me look", and a cook who hears that and then nothing has been abandoned
          // mid-sentence -- which reads as the system having crashed rather than as the network
          // having failed. Caught in the browser: the panel was correct and the room was silent.
          present(move.shown, move.shown.speech, Date.now());
          return;
        }
        const answer = parseModelGuidance(raw, move.shown);
        status = answer.source === 'model' ? '' : 'The model reply was unusable — local answer stands';
        present(answer, answer.speech, Date.now());
      })
      .catch(() => {
        if (token !== askToken) return;
        pending = false;
        status = 'Guidance request failed — local answer stands';
        present(move.shown, move.shown.speech, Date.now());
      });
  }

  // ---------------------------------------------------------------- the unprompted path

  /**
   * The autonomous watch.
   *
   * Runs off the analysis loop's own cadence rather than a timer of its own, throttled to at
   * most once a second, and does nothing but read two pure functions. All four refusals --
   * persistence, severity, cooldown, confidence -- are in `nag.ts`; none of them are repeated
   * here, so there is one place to look when the chef talks too much.
   */
  function watch(nowMs: number): void {
    if (session === null || intensity === 'off') return;
    if (nowMs - lastWatchMs < WATCH_INTERVAL_MS) return;
    lastWatchMs = nowMs;

    const ctx = buildContext(nowMs);
    const hit = session.interruption(nowMs, ctx.confidence, POLICY[intensity]());
    if (hit === null) return;

    // Built from the deficit's own instruction, which is a complete sentence written for the
    // cook and derived from a measurement. No model is asked -- see the header.
    const unprompted = localGuidance({ ...ctx, faults: [hit.instruction] }, false);
    present(unprompted, unprompted.speech, nowMs);
  }

  function observe(analysis: Analysis, nowMs = Date.now()): void {
    lastAnalysis = analysis;
    lastAnalysisAtMs = nowMs;
    session?.ingestPieces(piecesOf(analysis), nowMs);
    watch(nowMs);
  }

  // ---------------------------------------------------------------- listening

  /**
   * The wake-phrase trigger.
   *
   * On desktop Chrome this is the microphone. In Quest Browser there is no Web Speech API at
   * all (DECISIONS.md entry 17), so `bestProvider` hands back the typed provider and the panel
   * grows a text box that feeds the identical path. Not a debug affordance -- it is the tier
   * that works on the headset, and the one that works when the hall wifi collapses.
   */
  const speech: SpeechProvider = bestProvider({
    onHeard: (heard) => {
      if (!heard.final) return;
      const text = heard.text.trim();
      if (text === '') return;

      const nowMs = Date.now();
      if (text === lastHeard && nowMs - lastHeardAtMs < REPEAT_WINDOW_MS) return;
      lastHeard = text;
      lastHeardAtMs = nowMs;

      // Only "I am stuck" is acted on. Every other intent belongs to the full assistant in
      // `src/voice/assistant.ts`, and a second thing quietly handling "set the target" would
      // be two chefs disagreeing about the recipe.
      if (stuckIntent(text) === null) return;
      transcript.textContent = `“${text}”`;
      ask(text);
    },
    onError: (message) => {
      listenFault = message;
      changed();
    },
  });
  speech.start();

  // ---------------------------------------------------------------- OCR, on demand only

  /**
   * Reads a printed recipe card the cook holds up, once, when they ask for it.
   *
   * ON DEMAND AND NOT IN THE LOOP, and the honesty here matters more than the feature.
   * DECISIONS.md entry 21 measured segmentation at 87ms per frame on the headset; Tesseract is
   * heavier than that by a wide margin, and the analysis loop already runs at 420px on the long
   * edge, which is far below what any OCR engine needs for body text. Running it continuously
   * would cost the frame budget and return junk.
   *
   * So this takes the video at its FULL resolution -- not the analysis canvas -- votes across
   * three reads with `textVote`, and refuses to report anything the reads did not agree on.
   * What it is expected to manage is large print on a card held up to the camera. Reading a
   * recipe card lying flat on the counter at arm's length is UNVERIFIED on a headset and should
   * not be promised to anyone until somebody has tried it.
   */
  async function readCard(): Promise<void> {
    const video = options.video();
    if (video === null || video.videoWidth === 0) {
      cardStatus = 'The camera is not running.';
      changed();
      return;
    }

    cardStatus = 'Reading…';
    changed();

    try {
      const [{ createOcrReader }, { PSM }, vote] = await Promise.all([
        import('../vision/ocr.js'),
        import('tesseract.js'),
        import('../core/perception/textVote.js'),
      ]);

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx2d = canvas.getContext('2d');
      if (ctx2d === null) throw new Error('2d context unavailable');

      ocr ??= createOcrReader({
        lang: 'eng',
        // A card is a block of lines, not one label. SINGLE_LINE -- the default this repo uses
        // for price tags -- would read the first line and discard the rest.
        psm: PSM.SPARSE_TEXT,
        charWhitelist: '',
      });
      if (!(await ocr.ready)) throw new Error('OCR engine unavailable');

      // Three reads a beat apart, so a hand tremor or a reflection does not decide it alone.
      let state = vote.emptyVote();
      for (let i = 0; i < 3; i++) {
        ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);
        const regions = await ocr.read(canvas);
        for (const region of regions) state = vote.castVote(state, region.text, region.confidence);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      const agreed = vote.verdict(state);
      if (agreed === null) {
        cardText = null;
        // Null is a real answer here and is rendered as one. Reporting a best guess the reads
        // did not agree on is how a card that says "4 tomatoes" becomes "4 tomatuea".
        cardStatus = 'Nothing legible. Hold the card closer and flatter.';
      } else {
        cardText = agreed.text;
        cardStatus = `Read: “${agreed.text}”`;
      }
    } catch (error) {
      cardText = null;
      cardStatus = `Could not read a card: ${(error as Error).message}`;
    }
    changed();
  }

  // ---------------------------------------------------------------- the card

  const typed = h('input', {
    class: 'g-typed',
    attrs: {
      type: 'text',
      placeholder: 'hey chef, I don’t know what to do next',
      'aria-label': 'Say something to the chef',
      autocomplete: 'off',
    },
  });
  typed.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const text = typed.value.trim();
    if (text === '') return;
    typed.value = '';
    // Straight past the intent gate: pressing Enter in a box addressed to the chef IS the
    // trigger. Requiring "hey chef" from somebody who has already aimed at the box would be a
    // wake phrase protecting against nothing.
    transcript.textContent = `“${text}”`;
    ask(text);
  });

  const askButton = button('k-act k-act--go g-ask', () => ask(null), 'Unsure');
  const cardButton = button('k-act g-read', () => void readCard(), 'Read a card');

  function paintModes(): void {
    fill(
      modes,
      ...(['off', 'gentle', 'full'] as const).map((level) =>
        button(`g-mode${intensity === level ? ' is-on' : ''}`, () => {
          intensity = level;
          changed();
        }, level === 'off' ? 'Silent' : level === 'gentle' ? 'Gentle' : 'Full service'),
      ),
    );
  }

  /** The speech-input situation, which is a fact about the browser and not about the answer. */
  const rule = h('div', { class: 'g-rule' });

  function paint(): void {
    rule.textContent = listenFault !== ''
      ? `${listenFault}. Press Unsure, or type to the chef.`
      : speech.name === 'webspeech'
        ? 'Say “hey chef, I don’t know what to do next”, or press Unsure.'
        : 'This browser has no speech recognition, so type to the chef or press Unsure.';

    const answer = current;
    const stale = answer !== null && Date.now() - shownAtMs > OVERLAY_HOLD_MS;

    headline.textContent = answer === null
      ? 'Stuck? Ask me.'
      : answer.speech;
    body.textContent = answer === null
      ? 'I will tell you where you are in the recipe, what the camera can see, and the one thing '
        + 'worth doing next. I will also speak up on my own if something has been wrong for a while.'
      : answer.text;

    badge.textContent = pending
      ? 'thinking…'
      : answer === null
        ? model === null ? 'local' : 'ready'
        : answer.prompted
          ? answer.source === 'model' ? 'chef · model' : 'chef · local'
          : 'unprompted';
    badge.className = `g-badge${answer !== null && !answer.prompted ? ' is-alert' : ''}`
      + (pending ? ' is-pending' : '');

    note.textContent = status;
    note.style.display = status === '' ? 'none' : '';
    cardNote.textContent = cardStatus;
    cardNote.style.display = cardStatus === '' ? 'none' : '';
    // The typed box is the trigger whenever the microphone is not one -- whether because the
    // browser has no recogniser (Quest Browser) or because permission was refused.
    typed.style.display = speech.name === 'typed' || listenFault !== '' ? '' : 'none';

    pin.textContent = answer === null || stale ? '' : answer.overlay;
    pin.className = `g-pin${answer !== null && !answer.prompted ? ' is-alert' : ''}`;

    paintModes();
  }

  const node = h(
    'div',
    { class: 'g-card' },
    h(
      'div',
      { class: 'g-head' },
      h('div', { class: 'g-title', text: 'The chef' }),
      badge,
    ),
    headline,
    body,
    transcript,
    note,
    h('div', { class: 'g-actions' }, askButton, cardButton),
    cardNote,
    typed,
    h('div', { class: 'g-label', text: 'Speak up when' }),
    modes,
    rule,
  );

  paint();

  return {
    node,
    hasModel: model !== null,
    marker: () => {
      if (current === null) return null;
      if (Date.now() - shownAtMs > OVERLAY_HOLD_MS) return null;
      if (current.overlay === '') return null;
      return { x: anchor.x, y: anchor.y, node: pin };
    },
    observe,
    ask,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy: () => {
      askToken++;
      speech.stop();
      listeners.clear();
      void ocr?.terminate().catch(() => undefined);
      ocr = null;
    },
  };
}
