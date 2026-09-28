import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { restoreSpriteCanvas } from '../scripts/sprite-image.ts';
import type { GameContent } from '../shared/game-content.ts';

test('asymmetrically cropped sprites retain pixels at their original canvas position', async () => {
  const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 255, 255, 0, 255]);
  const png = await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer();
  const restored = await restoreSpriteCanvas(png, { width: 7, height: 6, left: 3, top: 1, pngWidth: 2, pngHeight: 2 });
  const { data, info } = await sharp(restored).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 7); assert.equal(info.height, 6);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 7; x++) {
    const pixel = data.subarray((y * 7 + x) * 4, (y * 7 + x + 1) * 4);
    const inside = x >= 3 && x < 5 && y >= 1 && y < 3;
    assert.deepEqual(pixel, inside ? pixels.subarray(((y - 1) * 2 + x - 3) * 4, ((y - 1) * 2 + x - 2) * 4) : Buffer.alloc(4));
  }
});

test('incorrect crop metadata fails instead of silently stretching or clipping artwork', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#fff' } }).png().toBuffer();
  const geometry = { width: 4, height: 4, left: 1, top: 1, pngWidth: 2, pngHeight: 2 };
  await assert.rejects(restoreSpriteCanvas(png, { ...geometry, left: 3 }), /Invalid sprite canvas/);
  await assert.rejects(restoreSpriteCanvas(png, { ...geometry, pngWidth: 1 }), /does not match/);
});

test('all seven lobby tile layers preserve complete 128-pixel cells including trimmed decorations', async () => {
  const content: GameContent = JSON.parse(await readFile('public/game/content.json', 'utf8'));
  const tiles = content.lobby.visuals.filter(v => v.id.includes(':'));
  assert.equal(new Set(tiles.map(v => v.id.split(':')[0])).size, 7);
  assert.ok(tiles.length > 6000);
  for (const tile of tiles) {
    const sprite = content.sprites[tile.sprite];
    assert.equal(sprite.width, 128, `${tile.id}: original cell width`);
    assert.equal(sprite.height, 128, `${tile.id}: original cell height`);
  }
});
