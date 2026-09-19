import { createWorker, PSM, type Worker } from 'tesseract.js';

import type { TextRegion } from '../core/perception/types.js';

/**
 * Tesseract, wrapped so the render loop never touches it.
 *
 * tesseract.js already runs the engine in a Web Worker, so the WASM never blocks the frame.
 * What it does NOT protect you from is the two things that actually go wrong:
 *
 *   1. Creating a worker per read. `createWorker` downloads and instantiates the WASM core and
 *      the language data -- tens of megabytes and several seconds. Doing that per frame is an
 *      instant, total stall that looks like the headset hanging. One worker, made at startup,
 *      reused forever.
 *
 *   2. Awaiting a recognise call from inside `update()`. The worker is off-thread but the
 *      promise still resolves on yours, and master spec rule #10 is absolute about this. Reads
 *      are fire-and-forget: the caller starts one and picks up the result whenever it lands.
 *
 * Language data is `tessdata_fast` by default -- about 4MB for English against 15MB for the
 * full model, for a couple of points of accuracy on clean text. On venue wifi that trade is not
 * close. Once fetched it is cached, so the cost is paid once per device if the first run
 * happens before judging rather than during it.
 */

export interface OcrOptions {
  readonly lang: string;
  /**
   * Page segmentation mode, and it matters more than any other setting.
   *
   * The default (AUTO) assumes a page of text and runs layout analysis to find columns and
   * paragraphs. Handed a 200x60 crop of one label it frequently decides there is no text at
   * all. SINGLE_LINE tells it what it is actually looking at, and on label crops that alone is
   * worth more than every preprocessing step combined.
   */
  readonly psm: PSM;
  /**
   * Restricts the alphabet. Empty means no restriction.
   *
   * When the target is known -- a weight, an expiry date, a temperature -- whitelisting digits
   * and a handful of symbols removes whole classes of confusion at a stroke. It is the cheapest
   * accuracy available and it is usually left on the table.
   */
  readonly charWhitelist: string;
}

export const DEFAULT_OCR_OPTIONS: OcrOptions = {
  lang: 'eng',
  psm: PSM.SINGLE_LINE,
  charWhitelist: '',
};

export interface OcrReader {
  /** Resolves once the engine is usable. Never rejects; check `ready` state instead. */
  readonly ready: Promise<boolean>;
  read(canvas: HTMLCanvasElement, opts?: Partial<OcrOptions>): Promise<TextRegion[]>;
  /** True while a read is outstanding. The caller uses this to avoid queueing up backlog. */
  readonly busy: boolean;
  terminate(): Promise<void>;
}

/**
 * One worker, created eagerly at startup.
 *
 * Call this as early as possible -- during the menu, the calibration step, anything -- so the
 * download overlaps with something the user is already doing. Leaving it until the first read
 * puts a multi-second stall at exactly the moment somebody first points at a label.
 */
export function createOcrReader(base: OcrOptions = DEFAULT_OCR_OPTIONS): OcrReader {
  let worker: Worker | null = null;
  let busy = false;

  const ready = (async (): Promise<boolean> => {
    try {
      worker = await createWorker(base.lang);
      await worker.setParameters({ tessedit_pageseg_mode: base.psm });
      return true;
    } catch (error) {
      console.warn('[mise] OCR unavailable:', error);
      worker = null;
      return false;
    }
  })();

  return {
    ready,
    get busy() { return busy; },

    async read(canvas, opts = {}): Promise<TextRegion[]> {
      if (!(await ready) || worker === null) return [];
      // One read at a time. Tesseract queues internally, and a backlog means results arriving
      // for poses that left the ring buffer -- they get dropped, having cost full inference.
      if (busy) return [];
      busy = true;
      try {
        const params: Record<string, unknown> = {};
        if (opts.psm !== undefined) params.tessedit_pageseg_mode = opts.psm;
        if (opts.charWhitelist !== undefined) {
          params.tessedit_char_whitelist = opts.charWhitelist;
        }
        if (Object.keys(params).length > 0) await worker.setParameters(params);

        const { data } = await worker.recognize(canvas, {}, { blocks: true });
        return toRegions(data, canvas.width, canvas.height);
      } catch (error) {
        console.warn('[mise] OCR read failed:', error);
        return [];
      } finally {
        busy = false;
      }
    },

    async terminate(): Promise<void> {
      try { await worker?.terminate(); } catch { /* nothing useful to do */ }
      worker = null;
    },
  };
}

/**
 * Flattens Tesseract's block/paragraph/line tree into flat regions in NORMALISED coordinates.
 *
 * Normalised because everything downstream -- voting, unprojection, the overlay -- works in
 * 0..1, and because these boxes are relative to the CROP rather than to the frame. Keeping
 * them normalised makes that conversion the caller's single explicit step instead of a pixel
 * offset quietly travelling through four functions.
 *
 * Tesseract reports confidence 0..100; it is rescaled to 0..1 here so it composes with every
 * other confidence in the codebase.
 */
function toRegions(data: unknown, width: number, height: number): TextRegion[] {
  const lines = extractLines(data);
  const out: TextRegion[] = [];
  for (const line of lines) {
    const text = String(line.text ?? '').trim();
    if (text === '') continue;
    const bbox = line.bbox;
    if (bbox === undefined) continue;
    out.push({
      text,
      confidence: Math.max(0, Math.min(1, Number(line.confidence ?? 0) / 100)),
      box: {
        x: bbox.x0 / width,
        y: bbox.y0 / height,
        w: (bbox.x1 - bbox.x0) / width,
        h: (bbox.y1 - bbox.y0) / height,
      },
    });
  }
  return out;
}

interface RawLine {
  text?: unknown;
  confidence?: unknown;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Walks whatever shape this version of tesseract.js returned.
 *
 * The result schema has moved between majors -- `data.lines` in some, nested under
 * `data.blocks[].paragraphs[].lines[]` in others, and `blocks` is only populated at all when
 * the recognise call asks for it. Rather than pin a version, this looks for both and falls
 * back to the whole-crop text, which is all a single-line PSM read produces anyway.
 */
function extractLines(data: unknown): RawLine[] {
  if (typeof data !== 'object' || data === null) return [];
  const d = data as Record<string, unknown>;

  if (Array.isArray(d.lines) && d.lines.length > 0) return d.lines as RawLine[];

  if (Array.isArray(d.blocks)) {
    const lines: RawLine[] = [];
    for (const block of d.blocks as Record<string, unknown>[]) {
      for (const para of (block.paragraphs ?? []) as Record<string, unknown>[]) {
        for (const line of (para.lines ?? []) as RawLine[]) lines.push(line);
      }
    }
    if (lines.length > 0) return lines;
  }

  const text = typeof d.text === 'string' ? d.text.trim() : '';
  if (text === '') return [];
  return [{ text, confidence: d.confidence, bbox: undefined }];
}
