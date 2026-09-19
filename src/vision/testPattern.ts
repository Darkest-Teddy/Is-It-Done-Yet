/**
 * A synthetic board with produce-coloured blobs of known size, hue and shape.
 *
 * Exists so the whole pipeline -- segmentation, feature extraction, classification, overlay --
 * can be exercised with no camera, no ingredients and no venue lighting. It is also the only
 * input in the project whose ground truth is known exactly, which makes it the thing to check
 * first when detection starts misbehaving: if the test pattern still classifies correctly, the
 * fault is in the camera or the lighting, not in the code.
 *
 * The blobs are drawn in HSL so the hue written here is the hue the classifier should recover,
 * give or take the antialiased rim that the contour mask averages in.
 */

export interface SyntheticBlob {
  readonly label: string;
  readonly hueDeg: number;
  readonly centre: { x: number; y: number };
  /** Full width and height in pixels, so elongation is widthPx / heightPx for a horizontal blob. */
  readonly widthPx: number;
  readonly heightPx: number;
  readonly rotationDeg: number;
}

/** Ground truth for the default scene. Sizes chosen to land inside the real profile windows. */
export const DEFAULT_SCENE: readonly SyntheticBlob[] = [
  { label: 'cucumber', hueDeg: 95, centre: { x: 330, y: 170 }, widthPx: 420, heightPx: 74, rotationDeg: -8 },
  { label: 'carrot', hueDeg: 24, centre: { x: 350, y: 560 }, widthPx: 330, heightPx: 62, rotationDeg: 6 },
  { label: 'tomato', hueDeg: 2, centre: { x: 830, y: 200 }, widthPx: 132, heightPx: 126, rotationDeg: 0 },
  { label: 'orange', hueDeg: 28, centre: { x: 1040, y: 380 }, widthPx: 128, heightPx: 124, rotationDeg: 0 },
  { label: 'lemon', hueDeg: 54, centre: { x: 840, y: 560 }, widthPx: 150, heightPx: 112, rotationDeg: 15 },
];

export interface TestPatternOptions {
  readonly width: number;
  readonly height: number;
  /** Lightness of the board, 0..1. A real light board photographs around 0.82, not 1.0. */
  readonly boardLightness: number;
  /** Per-pixel luminance noise, 0..1. Sensor grain the segmentation has to survive. */
  readonly noise: number;
  readonly scene: readonly SyntheticBlob[];
}

export const DEFAULT_TEST_PATTERN: TestPatternOptions = {
  width: 1280,
  height: 720,
  boardLightness: 0.82,
  noise: 0.03,
  scene: DEFAULT_SCENE,
};

/**
 * Renders the scene.
 *
 * Takes a canvas rather than creating one so the caller controls the lifetime -- this is called
 * every frame in test mode and a fresh canvas per frame is a steady leak of GPU-backed surfaces.
 */
export function drawTestPattern(
  canvas: HTMLCanvasElement,
  opts: TestPatternOptions = DEFAULT_TEST_PATTERN,
): ImageData {
  canvas.width = opts.width;
  canvas.height = opts.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('2d canvas context unavailable');

  // The board is deliberately near-achromatic rather than pure white: saturation is what
  // separates food from board, so a board with a slight warm cast is the honest test.
  const l = Math.round(opts.boardLightness * 100);
  ctx.fillStyle = `hsl(38 6% ${l}%)`;
  ctx.fillRect(0, 0, opts.width, opts.height);

  for (const blob of opts.scene) {
    ctx.save();
    ctx.translate(blob.centre.x, blob.centre.y);
    ctx.rotate((blob.rotationDeg * Math.PI) / 180);
    const gradient = ctx.createRadialGradient(
      -blob.widthPx * 0.15, -blob.heightPx * 0.25, blob.heightPx * 0.1,
      0, 0, blob.widthPx * 0.6,
    );
    // A flat fill segments too easily to prove anything. The gradient gives the shading a real
    // curved surface has, so the mean-hue reading has to cope with a spread rather than a value.
    gradient.addColorStop(0, `hsl(${blob.hueDeg} 72% 62%)`);
    gradient.addColorStop(1, `hsl(${blob.hueDeg} 78% 38%)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.ellipse(0, 0, blob.widthPx / 2, blob.heightPx / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  const frame = ctx.getImageData(0, 0, opts.width, opts.height);

  if (opts.noise > 0) {
    const amplitude = opts.noise * 255;
    const data = frame.data;
    for (let i = 0; i < data.length; i += 4) {
      const n = (Math.random() - 0.5) * 2 * amplitude;
      data[i] = clampByte(data[i]! + n);
      data[i + 1] = clampByte(data[i + 1]! + n);
      data[i + 2] = clampByte(data[i + 2]! + n);
    }
    ctx.putImageData(frame, 0, 0);
  }

  return frame;
}

const clampByte = (x: number): number => (x < 0 ? 0 : x > 255 ? 255 : x);
