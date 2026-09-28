import { readFile } from 'node:fs/promises';
import path from 'node:path';
import RAPIER from '@dimforge/rapier2d-compat';
import type { WorldKind } from './protocol.ts';
import type { GameContent } from './game-content.ts';
import { createWorld, type GameSimulation } from './world.ts';

export type { GameSimulation } from './world.ts';
let initialization: Promise<void> | undefined;

/** Server entry: loads prepared content from disk and builds an authoritative world. */
export async function createSimulation(kind: WorldKind): Promise<GameSimulation> {
  let content: GameContent;
  try { content = JSON.parse(await readFile(path.resolve('public/game/content.json'), 'utf8')); }
  catch (error) { throw new Error('游戏素材尚未准备，请先运行 npm run assets（需在 config.yaml 配置 assets.package）', { cause: error }); }
  if (content.version !== 1 || !content.challenge?.objects.length || !content.lobby?.visuals.length) throw new Error('游戏 content.json 格式不完整');
  await (initialization ??= RAPIER.init());
  return createWorld(RAPIER, kind, content);
}
