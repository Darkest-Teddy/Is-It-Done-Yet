import cv from '@techstark/opencv-js';

import { pickBark } from './core/barks.js';
import { hueDistanceDeg, identify } from './core/ingredients.js';
import {
  add as addEntry, type Entry, entryFrom, parseEntries, positionOf, rank,
} from './core/leaderboard.js';
import { progressOf, type Recipe, RECIPES } from './core/recipes.js';
import { createChef } from './audio/chef.js';
import { createChop } from './audio/chop.js';
import { feedbackForCut, type FeedbackOptions } from './core/feedback.js';
import {
  crossCheck, emptySession, recordCut, type Session, type SliceMeasurement,
} from './core/metrics.js';
import { formatScore, scoreSession, type ScoringOptions } from './core/scoring.js';
import { scaleFromDiameter } from './core/scale.js';
import { allTunables, setTunable, tunable, type TunableKey } from './core/tunables.js';
import {
  DEFAULT_TRACK_OPTIONS, emptyTrack, observe,
  type TrackBlob, type TrackOptions, type TrackState,
} from './core/track.js';
import type { Effect, GameState } from './core/voice/tools.js';
import { createAssistant, heardHandler } from './voice/assistant.js';
import { bestProvider, type SpeechProvider } from './voice/stt.js';
import { DEFAULT_CAMERA_OPTIONS, FrameGrabber, listCameras, open } from './vision/camera.js';
import { type Blob, segment, type SegmentOptions, useOpenCv } from './vision/segment.js';
import { decodeToImageData, firstImage } from './vision/imageSource.js';
import { drawTestPattern } from './vision/testPattern.js';

const statusEl = document.getElementById('status') as HTMLDivElement;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const controls = document.getElementById('controls') as HTMLElement;
const scoreEl = document.getElementById('score') as HTMLElement;
const detailEl = document.getElementById('detail') as HTMLElement;
const cutsEl = document.getElementById('cuts') as HTMLOListElement;
const ticketEl = document.getElementById('ticket') as HTMLElement;
const boardEl = document.getElementById('board') as HTMLOListElement;
const ctx = canvas.getContext('2d')!;

const status = (text: string): void => { statusEl.textContent = text; };

/**
 * Options are read from the registry every frame rather than copied into local state.
 *
 * Master spec rule #11 wants every magic number on a live slider, and the only way a slider is
 * genuinely live is if nothing caches what it set. At a venue you are dragging the saturation
 * floor while watching the outline, and a stale copy makes that read as the slider being broken.
 */
const segmentOptions = (): SegmentOptions => ({
  minSaturation: tunable('MIN_SATURATION'),
  minAreaPx: tunable('MIN_AREA_PX'),
  morphKernelPx: tunable('MORPH_KERNEL_PX'),
});

const trackOptions = (): TrackOptions => ({
  ...DEFAULT_TRACK_OPTIONS,
  knownDiameterMm: tunable('CUCUMBER_DIAMETER_MM'),
  settleFrames: Math.round(tunable('SETTLE_FRAMES')),
  settleBandMm: tunable('SETTLE_BAND_MM'),
  minCutMm: tunable('MIN_CUT_MM'),
  maxCutMm: tunable('MAX_CUT_MM'),
  maxScaleResidual: tunable('MAX_SCALE_RESIDUAL'),
  sliceMajorTolerance: tunable('SLICE_MAJOR_TOLERANCE'),
  maxSliceAspect: tunable('MAX_SLICE_ASPECT'),
  refractoryFrames: Math.round(tunable('REFRACTORY_FRAMES')),
  budgetSlack: tunable('BUDGET_SLACK'),
});

/**
 * The ticket, not the registry, sets the target once one is chosen.
 *
 * Asking for 4mm rounds is a different skill from asking for 12mm batons, so each ticket
 * carries its own tolerance; scoring both against one global window would flatter one and
 * punish the other. The registry keys remain the defaults and stay on their sliders, which is
 * what you want while tuning with no ticket in play.
 */
let activeRecipe: Recipe | null = null;

const scoringOptions = (): ScoringOptions => ({
  targetThicknessMm: activeRecipe?.targetThicknessMm ?? tunable('TARGET_THICKNESS_MM'),
  toleranceMm: activeRecipe?.toleranceMm ?? tunable('TOLERANCE_MM'),
  targetSigmaMm: activeRecipe?.targetSigmaMm ?? tunable('TARGET_SIGMA_MM'),
  angleToleranceDeg: tunable('ANGLE_TOLERANCE_DEG'),
});

const feedbackOptions = (): FeedbackOptions => ({
  targetThicknessMm: scoringOptions().targetThicknessMm,
  toleranceMm: scoringOptions().toleranceMm,
  maxThicknessMm: tunable('MAX_THICKNESS_MM'),
});

/** Produces one frame, or null when the source has nothing ready yet. */
type Source = () => ImageData | null;

const TUNABLE_STORE = 'mise.tunables';

/**
 * Overrides survive a reload.
 *
 * Retuning is done once on arrival, under the lighting that will be there all night, and losing
 * it to an accidental refresh at hour thirty is the kind of avoidable loss that reads as the
 * software being flaky. Failures here are swallowed: a private window with storage blocked must
 * not take the page down over a convenience.
 */
function saveTunables(): void {
  try {
    const out: Record<string, number> = {};
    for (const t of allTunables()) if (t.value !== t.default) out[t.key] = t.value;
    localStorage.setItem(TUNABLE_STORE, JSON.stringify(out));
  } catch { /* storage unavailable; the sliders still work for this session */ }
}

function loadTunables(): void {
  try {
    const raw = localStorage.getItem(TUNABLE_STORE);
    if (raw === null) return;
    const saved = JSON.parse(raw) as Record<string, number>;
    for (const [key, value] of Object.entries(saved)) setTunable(key as TunableKey, value);
  } catch { /* corrupt or unavailable; defaults are a fine starting point */ }
}

const BOARD_STORE = 'mise.leaderboard';

/**
 * At a booth with one laptop every player is on the same machine, so local storage IS the
 * shared store master spec 12 asks for. Wrapped because a blocked-storage browser must lose
 * the board, not the game.
 */
function loadBoard(): readonly Entry[] {
  try {
    const raw = localStorage.getItem(BOARD_STORE);
    return raw === null ? [] : parseEntries(JSON.parse(raw));
  } catch { return []; }
}

function saveBoard(entries: readonly Entry[]): void {
  try { localStorage.setItem(BOARD_STORE, JSON.stringify(entries)); } catch { /* ignore */ }
}

/**
 * Pulls each slider back into agreement with its tunable.
 *
 * Needed because the sliders are no longer the only thing that writes a tunable -- the chef
 * can be told "make it four millimetres" and will set one directly. A slider still showing 6
 * while the session is scored against 4 is worse than having no slider at all, because rule
 * #11 has trained everyone to believe it.
 */
const resyncSliders = new Map<TunableKey, () => void>();

function slider(view: { key: TunableKey; label: string; unit: string;
  min: number; max: number; step: number; value: number; }): void {
  const wrap = document.createElement('label');
  const name = document.createElement('span');
  const out = document.createElement('output');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(view.min);
  input.max = String(view.max);
  input.step = String(view.step);
  input.value = String(view.value);
  name.textContent = view.label;
  const show = (v: string): void => { out.textContent = view.unit === '' ? v : `${v}${view.unit}`; };
  show(String(view.value));
  input.addEventListener('input', () => {
    setTunable(view.key, Number(input.value));
    show(input.value);
    saveTunables();
  });
  resyncSliders.set(view.key, () => {
    input.value = String(tunable(view.key));
    show(input.value);
  });
  wrap.append(name, out, input);
  controls.append(wrap);
}

/** Call after anything but a slider drag changes a tunable. */
function resync(key: TunableKey): void {
  resyncSliders.get(key)?.();
  saveTunables();
}

function dropdown(label: string): HTMLSelectElement {
  const select = document.createElement('select');
  const wrap = document.createElement('label');
  const name = document.createElement('span');
  name.textContent = label;
  wrap.append(name, select);
  controls.prepend(wrap);
  return select;
}

type Role = 'stub' | 'slice' | 'other';

function drawBlob(blob: Blob, role: Role, mmPerPx: number | null): void {
  const named = identify(blob.features);
  const hue = blob.features.hueDeg;

  ctx.beginPath();
  blob.contour.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
  // The stub and the slices are what the measurement is made of, so they are drawn as what they
  // are. Everything else keeps the old behaviour of outlining in its own measured hue, which is
  // what tells you WHY a label is wrong without reading any of the numbers.
  ctx.strokeStyle = role === 'stub' ? '#8ee06a' : role === 'slice' ? '#6ac8e0' : `hsl(${hue} 90% 55%)`;
  ctx.lineWidth = role === 'other' ? 2 : 3;
  ctx.stroke();

  const { x, y } = blob.centroid;
  const lengthMm = mmPerPx === null ? null : blob.rect.majorPx * mmPerPx;
  const widthMm = mmPerPx === null ? null : blob.rect.minorPx * mmPerPx;

  const label = role === 'stub'
    ? (lengthMm === null ? 'stub' : `stub ${lengthMm.toFixed(0)}mm`)
    : role === 'slice'
      ? (widthMm === null ? 'slice' : `${widthMm.toFixed(1)}mm`)
      : named === null ? 'unidentified' : `${named.name}  ${(named.confidence * 100).toFixed(0)}%`;

  const detail = lengthMm !== null && widthMm !== null
    ? `${lengthMm.toFixed(0)} x ${widthMm.toFixed(1)}mm  ${hue.toFixed(0)}deg`
    : `${hue.toFixed(0)}deg  ${blob.features.elongation.toFixed(1)}:1  ` +
      `sat ${blob.features.saturation.toFixed(2)}  sol ${blob.features.solidity.toFixed(2)}`;

  ctx.textAlign = 'center';
  ctx.font = '600 16px ui-sans-serif, system-ui, sans-serif';
  const labelWidth = ctx.measureText(label).width;
  ctx.font = '400 12px ui-monospace, monospace';
  const boxWidth = Math.max(labelWidth, ctx.measureText(detail).width) + 18;

  ctx.fillStyle = 'rgba(10,12,16,0.85)';
  ctx.fillRect(x - boxWidth / 2, y - 26, boxWidth, 46);
  ctx.fillStyle = role === 'stub' ? '#8ee06a' : role === 'slice' ? '#6ac8e0'
    : named === null ? '#f0a35e' : '#8ee06a';
  ctx.font = '600 16px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(label, x, y - 7);
  ctx.fillStyle = '#9aa3ad';
  ctx.font = '400 12px ui-monospace, monospace';
  ctx.fillText(detail, x, y + 12);
}

/** Never throws. A camera that refuses or ignores permission must not take the page down. */
async function cameraSource(): Promise<Source | null> {
  try {
    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;

    const stream = await open();
    video.srcObject = stream;
    await video.play();
    const grabber = new FrameGrabber(video);

    // Device labels stay blank until permission has been granted at least once -- the browser
    // withholds them so a page cannot fingerprint your hardware before you consent. So the
    // picker is only worth building after the stream is live.
    const cameras = await listCameras();
    if (cameras.length > 1) {
      const select = dropdown('camera');
      for (const camera of cameras) {
        const option = document.createElement('option');
        option.value = camera.deviceId;
        option.textContent = camera.label;
        select.append(option);
      }
      select.addEventListener('change', () => {
        const current = video.srcObject as MediaStream | null;
        if (current !== null) for (const track of current.getTracks()) track.stop();
        void open({ deviceId: select.value, ...DEFAULT_CAMERA_OPTIONS })
          .then((next) => {
            video.srcObject = next;
            return video.play();
          })
          .catch((error: unknown) => {
            status(`could not switch camera: ${(error as Error).message}`);
          });
      });
    }

    return () => grabber.grab();
  } catch (error) {
    console.warn('[mise] camera unavailable, using the test pattern instead:', error);
    return null;
  }
}

/**
 * Still images, fed by drop, paste or the file picker.
 *
 * Returns null until something has been loaded, which the render loop already treats as "this
 * source has nothing yet" -- the same state a camera is in for its first frame or two.
 */
function imageSource(onLoad: (name: string) => void): {
  source: Source;
  load: (file: File) => void;
} {
  const scratch = document.createElement('canvas');
  let frame: ImageData | null = null;

  const load = (file: File): void => {
    void decodeToImageData(file, scratch)
      .then((decoded) => {
        frame = decoded;
        onLoad(`${file.name} · ${decoded.width}x${decoded.height}`);
      })
      .catch((error: unknown) => {
        onLoad(`could not decode ${file.name}: ${(error as Error).message}`);
      });
  };

  return { source: () => frame, load };
}

/**
 * A recorded cut, played back through the identical pipeline.
 *
 * Worth its thirty lines several times over. Tuning cut detection against a live cucumber means
 * a fresh cucumber, a steady hand and a camera for every attempt; against a video it means
 * pressing play. It is also the only way to compare two threshold settings on exactly the same
 * input, which is what tuning actually requires.
 */
function videoSource(onLoad: (note: string) => void): {
  source: Source;
  load: (file: File) => void;
  element: HTMLVideoElement;
} {
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.loop = true;
  video.controls = true;
  video.className = 'clip';
  let grabber: FrameGrabber | null = null;
  let url: string | null = null;

  const load = (file: File): void => {
    if (url !== null) URL.revokeObjectURL(url);
    url = URL.createObjectURL(file);
    video.src = url;
    grabber = new FrameGrabber(video);
    video.play().then(
      () => onLoad(`${file.name} · playing`),
      () => onLoad(`${file.name} · press play`),
    );
  };

  return { source: () => (grabber === null ? null : grabber.grab()), load, element: video };
}

/** Mirrors firstImage in imageSource.ts; the list is indexed, not iterable. */
function firstVideo(items: DataTransferItemList | null): File | null {
  if (items === null) return null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item !== undefined && item.kind === 'file' && item.type.startsWith('video/')) {
      const file = item.getAsFile();
      if (file !== null) return file;
    }
  }
  return null;
}

function testPatternSource(): Source {
  // Rendered once and reused. The scene is static, and its per-pixel noise pass is a JS loop
  // over ~3.7 million array entries -- running that every frame cost more than the entire
  // OpenCV pipeline did, and it was measuring nothing.
  const scratch = document.createElement('canvas');
  const frame = drawTestPattern(scratch);
  return () => frame;
}

async function start(): Promise<void> {
  const synthetic = testPatternSource();
  let camera: Source | null = null;
  let source: Source = synthetic;

  let session: Session = emptySession();
  let track: TrackState = emptyTrack();
  let lastCrossCheck = '';
  let board: readonly Entry[] = loadBoard();
  let saved = false;

  const chop = createChop(() => ({
    baseHz: tunable('AUDIO_BASE_HZ'),
    pitchRangeHz: tunable('AUDIO_PITCH_RANGE_HZ'),
    burstMs: tunable('AUDIO_BURST_MS'),
    bandpassQ: tunable('AUDIO_BANDPASS_Q'),
  }));

  // Keys come from the environment, never from source. With none present the chef falls
  // through to the browser voice, which is the tier that survives saturated venue wifi anyway.
  const chef = createChef(chop?.context ?? null, {
    apiKey: import.meta.env.VITE_ELEVENLABS_KEY as string | undefined,
    voiceId: import.meta.env.VITE_ELEVENLABS_VOICE as string | undefined,
  });

  const renderBoard = (): void => {
    boardEl.replaceChildren(...rank(board).slice(0, 8).map((e, i) => {
      const li = document.createElement('li');
      li.textContent =
        `${i + 1}. ${e.name}  ${e.meanMm.toFixed(1)}mm +/-${e.sigmaMm.toFixed(1)}`
        + `  (${e.cuts} cuts)`;
      return li;
    }));
  };

  const renderTicket = (): void => {
    if (activeRecipe === null) {
      ticketEl.textContent = 'Free practice — no ticket. Targets come from the sliders.';
      return;
    }
    const p = progressOf(activeRecipe, session.records.length);
    ticketEl.textContent =
      `${activeRecipe.name} — ${p.done}/${p.required} slices at `
      + `${activeRecipe.targetThicknessMm}mm. ${activeRecipe.note}`
      + (p.complete ? '  ✓ ticket complete' : '');
  };

  const resetSession = (): void => {
    session = emptySession();
    track = emptyTrack();
    lastCrossCheck = '';
    saved = false;
    cutsEl.replaceChildren();
    scoreEl.textContent = 'No cuts yet.';
    renderTicket();
  };

  /**
   * Asks for the camera WITHOUT waiting for the answer, and adopts it whenever it arrives.
   *
   * getUserMedia never rejects on an ignored permission prompt -- the promise simply stays
   * pending. The first version awaited it against an 8 second timeout, which produced the
   * worst of both: you glance away, the page gives up, and clicking Allow a moment later does
   * nothing at all because the source was decided once at startup.
   *
   * Running it in the background removes the race rather than shortening it. The test pattern
   * is up instantly so the page is never blank, and permission granted a minute later still
   * switches the feed over. Nothing is ever waiting on a human.
   */
  const requestCamera = (): void => {
    if (camera !== null) return;
    status('waiting for camera permission...');
    void cameraSource().then((ready) => {
      if (ready === null) {
        status('camera refused -- showing the test pattern');
        return;
      }
      camera = ready;
      // Only steal the view if the user has not deliberately chosen something else meanwhile.
      if (modes.value === 'camera') source = ready;
    });
  };

  const images = imageSource((note) => {
    dropNote.textContent = note;
    // Loading an image is an unambiguous request to look at it, so switch without being asked.
    modes.value = 'image';
    source = images.source;
  });

  const clips = videoSource((note) => {
    dropNote.textContent = note;
    modes.value = 'video';
    source = clips.source;
  });

  const modes = dropdown('source');
  for (const [value, text] of [
    ['camera', 'camera'], ['video', 'recorded clip'], ['image', 'image'], ['test', 'test pattern'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    modes.append(option);
  }
  // Default to the camera: it is what the page is for, and the test pattern shows underneath
  // until permission arrives, so choosing it costs nothing if the answer never comes.
  modes.value = 'camera';
  modes.addEventListener('change', () => {
    clips.element.classList.toggle('shown', modes.value === 'video');
    if (modes.value === 'image') { source = images.source; return; }
    if (modes.value === 'video') { source = clips.source; return; }
    if (modes.value !== 'camera') { source = synthetic; return; }
    if (camera !== null) source = camera; else requestCamera();
  });

  const tickets = dropdown('ticket');
  for (const [value, text] of [
    ['', 'free practice'] as const,
    ...RECIPES.map((r) => [r.id, `${r.name} · ${r.targetThicknessMm}mm`] as const),
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    tickets.append(option);
  }
  tickets.addEventListener('change', () => {
    activeRecipe = RECIPES.find((r) => r.id === tickets.value) ?? null;
    resetSession();
  });

  const reset = document.createElement('button');
  reset.id = 'reset';
  reset.textContent = 'New cucumber';
  // Doubles as the gesture that unblocks audio: a browser keeps an AudioContext suspended until
  // the page has been interacted with, and this is the button every player presses first.
  reset.addEventListener('click', () => { void chop?.resume(); resetSession(); });

  const save = document.createElement('button');
  save.id = 'save';
  save.textContent = 'Save to leaderboard';
  save.addEventListener('click', () => {
    const entry = entryFrom(
      window.prompt('Name for the board?') ?? '',
      activeRecipe?.id ?? 'free',
      scoreSession(session.records, scoringOptions()),
      Date.now(),
    );
    if (entry === null) { status('nothing to save yet'); return; }
    board = addEntry(board, entry);
    saved = true;
    saveBoard(board);
    renderBoard();
  });
  controls.append(reset, save);

  // ---- The chef's ears -------------------------------------------------------------------
  //
  // Master spec 9.2: the agent reads live game state and changes the game. Everything it
  // decides lives in src/core/voice, which is pure and tested; this block is only the wiring.
  //
  // Nothing here is on the render path. Speech arrives on its own events, and the answer is
  // computed from a state snapshot, so a slow or absent recogniser cannot cost a frame.

  /** Free practice is not in the recipe table, so it is described as one on demand. */
  const freePractice = (): Recipe => ({
    id: 'free', name: 'free practice', ingredient: 'cucumber',
    targetThicknessMm: tunable('TARGET_THICKNESS_MM'),
    toleranceMm: tunable('TOLERANCE_MM'),
    targetSigmaMm: tunable('TARGET_SIGMA_MM'),
    sliceCount: 8,
    note: 'Targets come from the sliders.',
  });

  const voiceState = (): GameState => ({
    score: scoreSession(session.records, scoringOptions()),
    recipe: activeRecipe ?? freePractice(),
    intensity: tunable('CHEF_INTENSITY'),
    // Owned by the assistant, which overwrites this before use.
    lastLine: null,
  });

  const applyEffect = (effect: Effect): void => {
    switch (effect.kind) {
      case 'setTarget':
        // A spoken thickness is an explicit instruction, so it drops the ticket rather than
        // fighting it -- a ticket's target is part of the ticket, and silently disagreeing
        // with the panel is how the score stops matching what is on screen.
        activeRecipe = null;
        tickets.value = '';
        setTunable('TARGET_THICKNESS_MM', effect.mm);
        resync('TARGET_THICKNESS_MM');
        renderTicket();
        break;
      case 'setRecipe':
        activeRecipe = RECIPES.find((r) => r.id === effect.id) ?? null;
        tickets.value = effect.id;
        resetSession();
        break;
      case 'setIntensity':
        setTunable('CHEF_INTENSITY', effect.intensity);
        resync('CHEF_INTENSITY');
        break;
      case 'reset':
        resetSession();
        break;
      case 'stop':
        // The assistant has already stopped the provider; reflect it in the button.
        break;
    }
    voiceButton.textContent = listenLabel();
  };

  let speech: SpeechProvider | null = null;
  const assistant = createAssistant({
    // Built lazily so the recogniser is only constructed once the player asks for it, and the
    // provider reference stays available to the effect handler above.
    provider: {
      name: 'typed', available: true,
      start: () => speech?.start(), stop: () => speech?.stop(),
      listening: () => speech?.listening() ?? false,
    },
    state: voiceState,
    apply: applyEffect,
    speak: (bark) => chef.say(bark),
    onReply: (reply) => { heardEl.textContent = reply.line; },
    onError: (message) => status(message),
  });

  const onHeard = heardHandler(assistant, (heard) => {
    // Interim text included: seeing the transcript form is what tells a player the microphone
    // is working, and it is the difference between "it is not listening" and "it misheard me".
    transcriptEl.textContent = heard.text;
    transcriptEl.classList.toggle('interim', !heard.final);
  });

  speech = bestProvider({ onHeard, onError: (message) => status(message) });

  const listenLabel = (): string =>
    speech?.listening() === true ? 'Stop listening' : `Listen (${speech?.name ?? 'none'})`;

  const voiceButton = document.createElement('button');
  voiceButton.id = 'listen';
  voiceButton.addEventListener('click', () => {
    // Doubles as the audio-unblocking gesture, same as "New cucumber".
    void chop?.resume();
    if (speech?.listening() === true) assistant.stop(); else assistant.start();
    voiceButton.textContent = listenLabel();
  });
  voiceButton.textContent = listenLabel();

  /**
   * The typed path, always present.
   *
   * Quest Browser does not implement the Web Speech API and venue wifi will not cooperate, so
   * this is not a debug affordance -- it is the tier that still works, and the one to demo
   * from if the room is loud.
   */
  const typeIn = document.createElement('input');
  typeIn.type = 'text';
  typeIn.id = 'ask';
  typeIn.placeholder = 'hey chef, is it done yet?';
  typeIn.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || typeIn.value.trim() === '') return;
    void chop?.resume();
    assistant.hear(typeIn.value);
    transcriptEl.textContent = typeIn.value;
    transcriptEl.classList.remove('interim');
    typeIn.value = '';
  });

  const voiceWrap = document.createElement('div');
  voiceWrap.id = 'voice';
  const transcriptEl = document.createElement('div');
  transcriptEl.id = 'transcript';
  const heardEl = document.createElement('div');
  heardEl.id = 'chefline';
  voiceWrap.append(voiceButton, typeIn, transcriptEl, heardEl);
  controls.append(voiceWrap);

  if (speech.name === 'typed') {
    status('speech recognition unavailable in this browser -- type to the chef instead');
  }

  const drop = document.createElement('div');
  drop.id = 'drop';
  drop.innerHTML =
    '<strong>drop a clip or an image</strong>' +
    '<span>or paste, or click to browse</span>' +
    '<em id="drop-note">nothing loaded</em>';
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*,video/*';
  picker.hidden = true;
  drop.append(picker);
  controls.append(drop, clips.element);
  const dropNote = document.getElementById('drop-note') as HTMLElement;

  /** Routes by type, so one drop zone serves both a still and a recorded cut. */
  const loadFile = (file: File): void => {
    if (file.type.startsWith('video/')) clips.load(file); else images.load(file);
    resetSession();
  };

  drop.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    if (file !== undefined) loadFile(file);
  });

  // Drop and paste are bound to the whole document, not just the zone: aiming for a 200px
  // target while dragging a file is a needless bit of precision to demand.
  for (const type of ['dragenter', 'dragover'] as const) {
    document.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add('over');
    });
  }
  for (const type of ['dragleave', 'drop'] as const) {
    document.addEventListener(type, () => drop.classList.remove('over'));
  }
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    const items = event.dataTransfer?.items ?? null;
    const video = firstVideo(items);
    if (video !== null) { loadFile(video); return; }
    const image = firstImage(items);
    if (image !== null) loadFile(image);
  });
  document.addEventListener('paste', (event) => {
    const file = firstImage(event.clipboardData?.items ?? null);
    if (file !== null) loadFile(file);
  });

  loadTunables();
  for (const group of ['vision', 'measurement', 'scoring', 'feedback'] as const) {
    const heading = document.createElement('h2');
    heading.textContent = group;
    controls.append(heading);
    for (const t of allTunables()) if (t.group === group) slider(t);
  }

  renderTicket();
  renderBoard();
  requestCamera();

  let lastFrame = performance.now();
  let smoothedMs = 16;
  let segmentMs = 0;

  const tick = (): void => {
    const frame = source();
    if (frame !== null) {
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
      }
      ctx.putImageData(frame, 0, 0);

      let blobs: Blob[] = [];
      let failure: string | null = null;
      const segmentStart = performance.now();
      try {
        blobs = segment(frame, segmentOptions());
      } catch (error) {
        failure = (error as Error).message;
      }
      // Timed separately from the frame delta on purpose. Frame delta includes whatever the
      // browser decides to do with requestAnimationFrame -- a backgrounded or throttled tab
      // reports 1fps however fast the pipeline is. Only this number says what the CV costs.
      segmentMs += (performance.now() - segmentStart - segmentMs) * 0.2;

      // Hue gate BEFORE tracking. Tracking takes the longest blob as the stub, and a bare
      // forearm is longer than a cucumber, passes the saturation floor, and is elongated and
      // convex. Without this the app measures an arm with total confidence.
      const hueCentre = tunable('PRODUCE_HUE_DEG');
      const hueTolerance = tunable('PRODUCE_HUE_TOLERANCE_DEG');
      const produce = blobs.filter(
        (b) => hueDistanceDeg(b.features.hueDeg, hueCentre) <= hueTolerance,
      );

      const opts = trackOptions();
      const forTracker: TrackBlob[] = produce.map((b) => ({
        majorPx: b.rect.majorPx,
        minorPx: b.rect.minorPx,
        areaPx: b.areaPx,
        hueDeg: b.features.hueDeg,
      }));
      const result = observe(track, forTracker, opts);
      track = result.state;

      if (result.cut !== null) {
        const { session: next, record } = recordCut(session, result.cut);
        session = next;
        const fb = feedbackForCut(record, feedbackOptions());

        // The honesty beat. Two methods that fail in unrelated ways -- occlusion and
        // segmentation drift for one, pose and the cos(angle) blind spot for the other -- so
        // agreement is evidence. DECISIONS entry 4 is why a disagreement is reported rather
        // than used to suppress the record: on a slanted cut they SHOULD differ.
        if (result.sideProfileMm !== null) {
          const side: SliceMeasurement = {
            thicknessMm: result.sideProfileMm, method: 'side-profile', confidence: 0.7,
          };
          const check = crossCheck(record, side, tunable('CROSSCHECK_TOLERANCE_MM'));
          lastCrossCheck = check.agree
            ? `both methods agree within ${check.deltaMm.toFixed(2)}mm`
            : `disagree by ${check.deltaMm.toFixed(2)}mm — ${check.reason}`;
        } else {
          lastCrossCheck = 'no slice edge-on, so only the stub measured this one';
        }

        const item = document.createElement('li');
        item.textContent =
          `${record.thicknessMm.toFixed(1)}mm` +
          (fb.kind === 'uncertain' ? '  (unconfirmed)' : '');
        item.className = fb.kind;
        cutsEl.append(item);
        cutsEl.scrollTop = cutsEl.scrollHeight;

        // Sound first, then speech. The chop is the physical acknowledgement and has to land on
        // the same beat as the knife; the line is commentary and can follow it.
        chop?.play(fb);
        chef.say(pickBark(
          record,
          scoreSession(session.records, scoringOptions()),
          fb,
          {
            intensity: tunable('CHEF_INTENSITY'),
            targetThicknessMm: scoringOptions().targetThicknessMm,
          },
        ));
        renderTicket();
      }

      const score = scoreSession(session.records, scoringOptions());
      // Where this run WOULD land, shown live. That is the thing that makes somebody want
      // another go, and it stops once the run has been saved so it is not claiming a place twice.
      const live = entryFrom('you', activeRecipe?.id ?? 'free', score, Date.now());
      scoreEl.textContent = formatScore(score, scoringOptions())
        + (live === null || board.length === 0 || saved
          ? '' : `  ·  #${positionOf(board, live)} on the board`);

      // The in-scene scale, recomputed from whatever the stub measures right now. A stored
      // calibration cannot notice the stand being knocked; this cannot fail to.
      const stubBlob = produce.reduce<Blob | null>(
        (best, b) => (best === null || b.rect.majorPx > best.rect.majorPx ? b : best), null,
      );
      const scale = stubBlob === null
        ? null
        : scaleFromDiameter(stubBlob.rect.minorPx, opts.knownDiameterMm);
      const mmPerPx = scale === null ? null : scale.mmPerPx;

      const sliceSet = new Set(
        stubBlob === null ? [] : produce.filter(
          (b) => b !== stubBlob && b.rect.majorPx > 0
            && b.rect.minorPx / b.rect.majorPx <= opts.maxSliceAspect
            && Math.abs(b.rect.majorPx / stubBlob.rect.minorPx - 1) <= opts.sliceMajorTolerance,
        ),
      );

      for (const b of blobs) {
        const role: Role = b === stubBlob ? 'stub' : sliceSet.has(b) ? 'slice' : 'other';
        drawBlob(b, role, mmPerPx);
      }

      detailEl.textContent = [
        result.stubLengthMm === null ? 'no stub' : `stub ${result.stubLengthMm.toFixed(0)}mm`,
        `${result.sliceCount} slice${result.sliceCount === 1 ? '' : 's'} edge-on`,
        result.sideProfileMm === null
          ? 'side-profile —' : `side-profile ${result.sideProfileMm.toFixed(1)}mm`,
        result.rejection === null ? 'CUT' : result.rejection,
        lastCrossCheck,
      ].filter((s) => s !== '').join('  ·  ');

      const now = performance.now();
      // Exponentially smoothed: a raw per-frame figure is unreadable and hides the trend.
      smoothedMs += ((now - lastFrame) - smoothedMs) * 0.1;
      lastFrame = now;
      status(
        failure ??
        `${blobs.length} blob${blobs.length === 1 ? '' : 's'} · ` +
        `${produce.length} produce · ` +
        (mmPerPx === null ? 'uncalibrated · ' : `${mmPerPx.toFixed(3)}mm/px · `) +
        `cv ${segmentMs.toFixed(1)}ms · ` +
        `frame ${smoothedMs.toFixed(1)}ms (${(1000 / smoothedMs).toFixed(0)}fps) · ` +
        `${frame.width}x${frame.height}`,
      );
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// OpenCV.js resolves its WASM asynchronously and builds differ in how they announce it, so
// handle both shapes: a thenable default export, and the classic onRuntimeInitialized callback.
const ready = typeof (cv as unknown as { then?: unknown }).then === 'function'
  ? (cv as unknown as Promise<typeof cv>)
  : new Promise<typeof cv>((resolve) => {
      (cv as unknown as { onRuntimeInitialized: () => void }).onRuntimeInitialized =
        () => resolve(cv);
    });

ready
  .then((instance) => {
    useOpenCv(instance);
    return start();
  })
  .catch((error: unknown) => {
    status(`failed to start: ${(error as Error).message}`);
    console.error('[mise]', error);
  });

