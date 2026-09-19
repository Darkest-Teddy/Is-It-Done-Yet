/**
 * Still images as a frame source: dropped files, a file picker, or a paste.
 *
 * This is the most useful test input there is short of the real rig. A photograph of a real
 * cucumber under real kitchen light exercises everything the synthetic pattern cannot --
 * specular highlights, shadow, colour cast, texture, a background that is not a clean board --
 * and unlike a live camera it holds perfectly still while you drag a threshold slider.
 */

/**
 * Longest edge a decoded image is scaled to.
 *
 * Phone photos arrive at 4000px and beyond. Segmentation cost scales with pixel count, so a
 * full-resolution still costs roughly ten times a camera frame for detail the classifier does
 * not use -- it reads mean hue and two axis ratios, neither of which improves past about
 * 1600px. Capping here also keeps still-image timings comparable to live ones.
 */
export const MAX_EDGE_PX = 1600;

/** Decodes an image file into pixels, downscaled to `maxEdge`, reusing the caller's canvas. */
export async function decodeToImageData(
  file: Blob,
  canvas: HTMLCanvasElement,
  maxEdge: number = MAX_EDGE_PX,
): Promise<ImageData> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) throw new Error('2d canvas context unavailable');

    // High-quality downscale: the browser's default is a box filter that aliases hard edges
    // into speckle, and speckle is exactly what the morphological open is meant to remove.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  } finally {
    // ImageBitmaps hold a GPU-backed surface until closed. Dropping twenty photos in a row
    // without this is twenty leaked surfaces.
    bitmap.close();
  }
}

/** First image found in a drop or paste, or null if there wasn't one. */
export function firstImage(items: DataTransferItemList | null): File | null {
  if (items === null) return null;
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue;
    if (!item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file !== null) return file;
  }
  return null;
}
