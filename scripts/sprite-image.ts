import sharp from 'sharp';

/** Original canvas and the exported PNG's top-left position, in pixels (Y down). */
export interface SpriteGeometry {
  width: number; height: number; left: number; top: number; pngWidth: number; pngHeight: number;
}

/** Restore transparent margins before atlas extrusion; never stretch a cropped sprite. */
export async function restoreSpriteCanvas(file: string | Buffer, geometry: SpriteGeometry): Promise<Buffer> {
  const { width, height, left, top, pngWidth, pngHeight } = geometry;
  const right = width - left - pngWidth, bottom = height - top - pngHeight;
  if (![width, height, left, top, pngWidth, pngHeight].every(Number.isInteger)
      || Math.min(width, height, pngWidth, pngHeight) <= 0 || Math.min(left, top, right, bottom) < 0) {
    throw new Error('Invalid sprite canvas geometry');
  }
  const image = sharp(file).ensureAlpha(), actual = await image.metadata();
  if (actual.width !== pngWidth || actual.height !== pngHeight) throw new Error('Sprite PNG does not match exported crop dimensions');
  return image.extend({ left, top, right, bottom, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}
