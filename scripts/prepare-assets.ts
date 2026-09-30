import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import subsetFont from 'subset-font';
import { restoreSpriteCanvas, type SpriteGeometry } from './sprite-image.ts';
import { loadConfig, PROJECT_ROOT } from '../server/config.ts';
import { GAME_RULES } from '../shared/game-behavior.ts';
import type {
  GameAtlas,
  GameContent,
  GameVisual,
  GameSprite,
  GameCharacter,
  GameCollider,
  Bounds,
  Point,
} from '../shared/game-content.ts';

// Source JSON is an external export format; it is deliberately normalized here only.
type Source = Record<string, any>;
const sourceArg = process.argv.indexOf('--source');
if (sourceArg >= 0 && !process.argv[sourceArg + 1]) throw new Error('--source 需要素材包目录');
const configured = loadConfig().assets?.package;
if (sourceArg < 0 && !configured)
  throw new Error('未配置素材包目录：在 config.yaml 设置 assets.package，或传入 --source <素材包目录>');
const delivery = sourceArg >= 0 ? path.resolve(process.argv[sourceArg + 1]) : path.resolve(PROJECT_ROOT, configured!);
// Manifest paths are relative to two levels above the export directory that contains the package.
const exported = path.dirname(delivery);
const sourceRoot = path.resolve(exported, '../..');
const output = path.resolve('public/game');
// Sprites are registered with their source PNG first and packed into atlases at the end.
type PendingSprite = Omit<GameSprite, 'atlas' | 'frame'>;
const sprites: Record<string, PendingSprite> = {};
const spriteSources: Record<string, string> = {};
const sources: Record<string, string> = {};
const copied = new Map<string, string>();
const normalized: Record<string, number> = {};
function normalizeNumbers(text: string, name: string): string {
  // Replace Python JSON numeric extensions only outside quoted strings.
  let quoted = false,
    escaped = false,
    output = '',
    count = 0;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (!quoted) {
      const token = /^(?:NaN|-?Infinity)(?=\s*[,}\]])/.exec(text.slice(i));
      if (token && /[:\[,]\s*$/.test(output)) {
        output += 'null';
        i += token[0].length;
        count++;
        continue;
      }
    }
    output += ch;
    i++;
    if (quoted && escaped) escaped = false;
    else if (quoted && ch === '\\') escaped = true;
    else if (ch === '"') quoted = !quoted;
  }
  if (count) normalized[name] = count;
  return output;
}
const read = async (name: string): Promise<any> =>
  JSON.parse(normalizeNumbers(await readFile(path.join(delivery, name), 'utf8'), name));
const geometry: Record<string, SpriteGeometry> = await read('sprite-geometry.json').catch(() => {
  throw new Error('素材包缺少 sprite-geometry.json；请由素材提供方补齐精灵裁切信息，接入要求见 docs/development.md');
});
await mkdir(path.join(output, 'assets'), { recursive: true });
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

async function asset(source: string, fixedName?: string): Promise<string> {
  if (copied.has(source)) return copied.get(source)!;
  const absolute = path.resolve(sourceRoot, source);
  const allowed = exported + path.sep;
  if (!absolute.startsWith(allowed)) throw new Error(`引用超出已导出素材目录：${source}`);
  const bytes = await readFile(absolute);
  const name =
    fixedName ?? `assets/${createHash('sha256').update(bytes).digest('hex')}${path.extname(source).toLowerCase()}`;
  const target = path.resolve(output, name);
  if (!target.startsWith(output + path.sep)) throw new Error('无效资源输出路径');
  await mkdir(path.dirname(target), { recursive: true });
  const exists = await stat(target).catch(() => null);
  if (!exists || exists.size !== bytes.length || (fixedName && !(await readFile(target)).equals(bytes)))
    await copyFile(absolute, target);
  const url = `/game/${name.replaceAll('\\', '/')}`;
  copied.set(source, url);
  sources[source] = url;
  return url;
}
async function sprite(value: Source | null): Promise<string> {
  if (!value?.path) throw new Error('现有交付包含没有 PNG 路径的精灵');
  const id = hash(value.path);
  const canvas = geometry[value.path];
  if (!canvas) throw new Error(`精灵缺少原始画布与裁切偏移：${value.path}`);
  if (!sprites[id])
    ((spriteSources[id] = value.path),
      (sprites[id] = {
        width: canvas.width,
        height: canvas.height,
        ppu: value.pixels_per_unit || 100,
        pivot: value.pivot ?? { x: 0.5, y: 0.5 },
        border: value.border ?? { x: 0, y: 0, z: 0, w: 0 },
      }));
  return id;
}
function tint(color: Source = {}): number {
  return (
    (Math.round((color.r ?? 1) * 255) << 16) |
    (Math.round((color.g ?? 1) * 255) << 8) |
    Math.round((color.b ?? 1) * 255)
  );
}
async function visual(node: Source, offset: Point = { x: 0, y: 0 }): Promise<GameVisual> {
  const id = await sprite(node.sprite),
    item = sprites[id],
    w = node.world,
    r = node.renderer ?? {};
  const sx = r.m_DrawMode ? (r.m_Size.x * w.scale_x) / item.width : w.scale_x / item.ppu;
  const sy = r.m_DrawMode ? (r.m_Size.y * w.scale_y) / item.height : w.scale_y / item.ppu;
  const angle = w.angle || 0,
    c = Math.cos(angle),
    s = Math.sin(angle);
  return {
    id: node.id,
    sprite: id,
    matrix: [sx * c, -sx * s, sy * s, sy * c, w.x - offset.x, -(w.y - offset.y)],
    tint: tint(r.m_Color),
    alpha: r.m_Color?.a ?? 1,
    order: r.m_SortingOrder ?? 0,
  };
}
async function readTextTree(directory: string): Promise<string> {
  let text = '';
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && /\.(tsx?|css)$/.test(entry.name))
      text += await readFile(path.join(entry.parentPath, entry.name), 'utf8');
  }
  return text;
}
const ATLAS_MAX = 2048,
  EXTRUDE = 1,
  PADDING = 2;
// Lobby art is large painted scenery: lossy colour with lossless alpha is ~4x smaller than
// lossless and visually equivalent at game zoom. Small character/stage sheets stay lossless.
const LOBBY_WEBP = { quality: 90, alphaQuality: 100, effort: 6 } as const;
/** Shelf-packs each group into WebP pages; edges are extruded so scaled tiles do not bleed. */
async function packAtlases(groupList: [string, Set<string>][]) {
  const atlases: Record<string, GameAtlas> = {},
    packed: Record<string, GameSprite> = {};
  const assigned = new Set<string>();
  for (const [group, members] of groupList) {
    // A sprite shared by several groups lives in the first one; loaders resolve atlases per sprite.
    // A single-sprite page (the tiled background) is emitted at exact size so it can repeat.
    const extrude = members.size === 1 ? 0 : EXTRUDE,
      padding = members.size === 1 ? 0 : PADDING;
    const items = [...members]
      .filter(id => !assigned.has(id))
      .map(id => ({ id, w: sprites[id].width + 2 * extrude, h: sprites[id].height + 2 * extrude }));
    items.forEach(item => assigned.add(item.id));
    if (!items.length) continue;
    items.sort((a, b) => b.h - a.h || b.w - a.w || a.id.localeCompare(b.id));
    const area = items.reduce((sum, item) => sum + (item.w + padding) * (item.h + padding), 0);
    const width =
      members.size === 1
        ? items[0].w
        : Math.min(ATLAS_MAX, Math.max(...items.map(item => item.w), 2 ** Math.ceil(Math.log2(Math.sqrt(area) * 1.1))));
    const pages: { placements: { id: string; x: number; y: number }[]; height: number }[] = [];
    let page: (typeof pages)[number] = { placements: [], height: 0 },
      x = 0,
      y = 0,
      shelf = 0;
    for (const item of items) {
      if (x + item.w > width) {
        x = 0;
        y += shelf + padding;
        shelf = 0;
      }
      if (y + item.h > ATLAS_MAX) {
        pages.push(page);
        page = { placements: [], height: 0 };
        x = 0;
        y = 0;
        shelf = 0;
      }
      page.placements.push({ id: item.id, x, y });
      page.height = Math.max(page.height, y + item.h);
      x += item.w + padding;
      shelf = Math.max(shelf, item.h);
    }
    pages.push(page);
    for (const [index, { placements, height }] of pages.entries()) {
      const layers = await Promise.all(
        placements.map(async ({ id, x, y }) => {
          const file = path.resolve(sourceRoot, spriteSources[id]);
          if (!file.startsWith(exported + path.sep)) throw new Error(`引用超出已导出素材目录：${spriteSources[id]}`);
          const restored = await restoreSpriteCanvas(file, geometry[spriteSources[id]]);
          const input = await sharp(restored)
            .extend({ top: extrude, bottom: extrude, left: extrude, right: extrude, extendWith: 'copy' })
            .png()
            .toBuffer();
          return { input, left: x, top: y };
        }),
      );
      const bytes = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite(layers)
        .webp(group === 'lobby' ? LOBBY_WEBP : { lossless: true, effort: 6 })
        .toBuffer();
      const name = `assets/${createHash('sha256').update(bytes).digest('hex')}.webp`;
      await writeFile(path.join(output, name), bytes);
      const atlasId = pages.length > 1 ? `${group}-${index}` : group;
      atlases[atlasId] = { url: `/game/${name}`, width, height };
      for (const { id, x, y } of placements)
        packed[id] = { ...sprites[id], atlas: atlasId, frame: { x: x + extrude, y: y + extrude } };
    }
  }
  for (const id of Object.keys(sprites)) if (!packed[id]) throw new Error(`精灵未被任何图集引用：${spriteSources[id]}`);
  return { atlases, packed };
}
/** public/game is generated; remove files from earlier runs so builds only ship live assets. */
async function removeStale(live: Set<string>) {
  for (const directory of ['assets', 'fonts']) {
    for (const name of await readdir(path.join(output, directory))) {
      if (!live.has(`/game/${directory}/${name}`)) await rm(path.join(output, directory, name));
    }
  }
}
const animations: Source[] = await read('character-animations.json');
const characterNames: Record<string, string> = {
  Male: '小伙伴',
  Female: '小女孩',
  Cat: '小猫',
  Furry: '毛茸茸',
  Girl2: '少女',
  Ox2: '小牛',
  Pig: '小猪',
  Pirate: '海盗',
  Police: '警官',
  Racoon: '浣熊',
  Racoon2: '小浣熊',
  SpaceMan: '宇航员',
};
const characters: GameCharacter[] = [];
for (const bundle of [...new Set(animations.map(a => a.bundle as string))]) {
  const scene = await read(`scenes/${bundle.replace(/_[a-f0-9]{32}\.unity3d$/, '')}.json`);
  const clips = animations.filter(a => a.bundle === bundle);
  const prefix = clips[0].name.split('_')[0],
    id = prefix.toLowerCase();
  const root = scene.nodes.find((n: Source) => n.parent_transform_id === '0');
  const layers = await Promise.all(
    scene.nodes.filter((n: Source) => n.sprite && n.active).map((n: Source) => visual(n, root?.world)),
  );
  layers.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  // Parent Show must precede its Body overlay when Unity gives both the same order.
  layers.sort((a, b) => {
    const an = scene.nodes.find((n: Source) => n.id === a.id),
      bn = scene.nodes.find((n: Source) => n.id === b.id);
    return a.order - b.order || an.hierarchy_path.split('/').length - bn.hierarchy_path.split('/').length;
  });
  const gameClips = [];
  for (const clip of clips) {
    const frames = [];
    for (const f of clip.frames)
      frames.push({ time: f.time, node: f.target.node_id, sprite: f.clear_sprite ? null : await sprite(f.sprite) });
    gameClips.push({ name: clip.name.slice(prefix.length + 1), duration: clip.duration, loop: clip.loop, frames });
  }
  const preview = await asset(path.relative(sourceRoot, path.join(delivery, `previews/characters/${prefix}_Idle.png`)));
  characters.push({ id, name: characterNames[prefix] ?? prefix, preview, layers, animations: gameClips, atlases: [] });
}
characters.sort((a, b) => (a.id === 'cat' ? -1 : b.id === 'cat' ? 1 : a.id.localeCompare(b.id)));

const lobbyScene = await read('scenes/scene.square_map.json');
const visuals: GameVisual[] = [],
  colliders: GameCollider[] = [];
const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
const grid = lobbyScene.nodes
  .find((n: Source) => n.components.some((c: Source) => c.type === 'Grid'))
  ?.components.find((c: Source) => c.type === 'Grid').data;
const cellX = (grid?.m_CellSize.x ?? 1) + (grid?.m_CellGap.x ?? 0),
  cellY = (grid?.m_CellSize.y ?? 1) + (grid?.m_CellGap.y ?? 0);
for (const node of lobbyScene.nodes as Source[]) {
  if (!node.active) continue;
  const world = node.world,
    tilemap = node.tilemap;
  if (tilemap) {
    const order = node.components.find((c: Source) => c.type === 'TilemapRenderer')?.data.m_SortingOrder ?? 0;
    for (const [position, data] of tilemap.tiles) {
      const sourceSprite = tilemap.sprites[data.m_TileSpriteIndex];
      if (!sourceSprite) continue;
      const spriteId = await sprite(sourceSprite),
        ppu = sprites[spriteId].ppu;
      const m = tilemap.matrices[data.m_TileMatrixIndex]?.m_Data ?? { e00: 1, e11: 1 };
      const color = tilemap.colors[data.m_TileColorIndex]?.m_Data ?? {};
      const x = world.x + ((position.x + tilemap.anchor.x) * cellX + (m.e03 ?? 0)) * world.scale_x;
      const y = world.y + ((position.y + tilemap.anchor.y) * cellY + (m.e13 ?? 0)) * world.scale_y;
      visuals.push({
        id: `${node.id}:${position.x}:${position.y}`,
        sprite: spriteId,
        matrix: [
          (world.scale_x * (m.e00 ?? 1)) / ppu,
          (-world.scale_y * (m.e10 ?? 0)) / ppu,
          (-world.scale_x * (m.e01 ?? 0)) / ppu,
          (world.scale_y * (m.e11 ?? 1)) / ppu,
          x,
          -y,
        ],
        tint: tint(color),
        alpha: color.a ?? 1,
        order,
      });
      if (node.name === 'diban') {
        bounds.minX = Math.min(bounds.minX, x - world.scale_x / 2);
        bounds.maxX = Math.max(bounds.maxX, x + world.scale_x / 2);
        bounds.minY = Math.min(bounds.minY, y - world.scale_y / 2);
        bounds.maxY = Math.max(bounds.maxY, y + world.scale_y / 2);
      }
    }
    const composite = node.components.find((c: Source) => c.type === 'CompositeCollider2D')?.data;
    // Composite export vertices already include the source world scale (128).
    for (const points of composite?.m_CompositePaths?.m_Paths ?? []) {
      if (points.length >= 3) colliders.push({ source: node.name, kind: 'polyline', x: world.x, y: world.y, points });
    }
  } else if (node.sprite && node.renderer?.m_Enabled) visuals.push(await visual(node));
  for (const component of node.components as Source[]) {
    const c = component.data;
    if (component.type === 'BoxCollider2D' && c.m_Enabled && !c.m_IsTrigger)
      colliders.push({
        source: node.name,
        kind: 'box',
        x: world.x + c.m_Offset.x * world.scale_x,
        y: world.y + c.m_Offset.y * world.scale_y,
        width: Math.abs(c.m_Size.x * world.scale_x),
        height: Math.abs(c.m_Size.y * world.scale_y),
        angle: world.angle,
      });
  }
}
visuals.sort((a, b) => a.order - b.order);
const map = await read('challenge10.json');
const challengeScene = await read('scenes/co_plat_2d.map.challenge10.json');
const assetList: Source[] = await read('assets.json');
const spritesByPathId = new Map(
  assetList.filter(item => item.type === 'Sprite' && item.path_id != null).map(item => [String(item.path_id), item]),
);
const objects = [];
for (const object of map.objects) {
  const node = challengeScene.nodes.find((n: Source) => n.id === object.id);
  const openedReference = node?.references?.find((reference: Source) => reference.key === 'DoorOpened');
  const openedAsset = spritesByPathId.get(String(openedReference?.gameObject?.m_PathID));
  const openedExport = openedAsset?.exports?.find((entry: Source) => /\.png$/i.test(entry.path));
  const openedSprite = openedExport
    ? await sprite({
        ...object.sprite,
        ...openedAsset,
        path: openedExport.path,
        // The export manifest has no raster dimensions; both door states share the
        // Door object's renderer size and pivot in the recovered scene.
        width: object.sprite.width,
        height: object.sprite.height,
      })
    : undefined;
  objects.push({
    ...object,
    sprite: await sprite(object.sprite),
    ...(openedSprite ? { openedSprite } : {}),
    tint: tint(node?.renderer?.m_Color),
  });
}
// The map is MapSize wide and starts half a reference view left of x = 0; vertically
// it spans the platforms. The camera never shows anything outside these bounds.
const mapSize = Number(map.parameters?.MapSize);
if (!Number.isFinite(mapSize) || mapSize <= GAME_RULES.challenge.view.width) throw new Error('关卡缺少有效的 MapSize');
const platforms = objects.filter(o => o.type === 2);
const challengeBounds: Bounds = {
  minX: -GAME_RULES.challenge.view.width / 2,
  maxX: mapSize - GAME_RULES.challenge.view.width / 2,
  minY: Math.min(...platforms.map(o => o.y - o.height / 2)),
  maxY: Math.max(...platforms.map(o => o.y + o.height / 2)),
};
const background = (await read('scenes/co_plat_2d.bg.json')).nodes.find((n: Source) => n.sprite);
const audio: Record<string, string> = {};
for (const item of assetList)
  for (const entry of item.exports) {
    if (/\.m4a$/i.test(entry.path)) audio[item.name] = await asset(entry.path);
  }
const font = assetList.flatMap(a => a.exports).find((a: Source) => /F_Default.*\.ttf$/i.test(a.path));
if (!font) throw new Error('交付中缺少 F_Default TTF 字体');
// The display font only renders fixed client copy; subset it to the characters used by the web client.
const glyphs = new Set(
  [...(await readTextTree(path.resolve('src'))), ...Object.values(characterNames).join('')].filter(ch =>
    /[\u3000-\u9fff\uff00-\uffef]/.test(ch),
  ),
);
for (let code = 32; code < 127; code++) glyphs.add(String.fromCharCode(code));
const fontBytes = await subsetFont(await readFile(path.resolve(sourceRoot, font.path)), [...glyphs].sort().join(''), {
  targetFormat: 'woff2',
});
await mkdir(path.join(output, 'fonts'), { recursive: true });
await writeFile(path.join(output, 'fonts/game.woff2'), fontBytes);
sources[font.path] = '/game/fonts/game.woff2';
const spawn = lobbyScene.nodes.find((n: Source) => n.name === 'MatchingSpawningArea0')?.world ?? { x: 0, y: 0 };
const backgroundSprite = await sprite(background.sprite);
// Atlas groups follow load boundaries: lobby, each character, the stage, and the tiled
// background alone because TilingSprite repeats a whole texture.
const spriteIds = (ids: (string | null | undefined)[]) => new Set(ids.filter((id): id is string => !!id));
const groups: [string, Set<string>][] = [
  ['lobby', spriteIds(visuals.map(v => v.sprite))],
  ...characters.map(
    c =>
      [
        `character-${c.id}`,
        spriteIds([...c.layers.map(l => l.sprite), ...c.animations.flatMap(a => a.frames.map(f => f.sprite))]),
      ] as [string, Set<string>],
  ),
  ['challenge', spriteIds(objects.flatMap(o => [o.sprite, o.openedSprite]))],
  ['challenge-background', spriteIds([backgroundSprite])],
];
const { atlases, packed } = await packAtlases(groups);
const atlasesFor = (ids: Iterable<string>) => [...new Set([...ids].map(id => packed[id].atlas))].sort();
for (const [index, character] of characters.entries()) character.atlases = atlasesFor(groups[index + 1][1]);
const content: GameContent = {
  version: 1,
  atlases,
  sprites: packed,
  characters,
  lobby: { visuals, colliders, bounds, spawn: { x: spawn.x, y: spawn.y }, atlases: atlasesFor(groups[0][1]) },
  challenge: {
    name: map.name,
    objects,
    rope: map.rope,
    background: backgroundSprite,
    bounds: challengeBounds,
    atlases: atlasesFor([...groups.at(-2)![1], backgroundSprite]),
  },
  audio,
};
for (const v of [...visuals, ...characters.flatMap(c => c.layers)]) {
  if (!v.matrix.every(n => typeof n === 'number' && Number.isFinite(n)))
    throw new Error(`场景矩阵存在非法数值：${v.id}`);
}
for (const object of objects)
  if (
    ![object.x, object.y, object.width, object.height, object.angle].every(
      n => typeof n === 'number' && Number.isFinite(n),
    )
  )
    throw new Error(`关卡几何存在非法数值：${object.id}`);
if (!visuals.length || !Object.values(bounds).every(Number.isFinite)) throw new Error('大厅图块或边界无效');
for (const c of colliders)
  if (
    ![c.x, c.y, ...(c.points?.flatMap(p => [p.x, p.y]) ?? [c.width!, c.height!])].every(
      n => typeof n === 'number' && Number.isFinite(n),
    )
  )
    throw new Error(`大厅碰撞存在非法数值：${c.source}`);
await writeFile(path.join(output, 'content.json'), JSON.stringify(content));
// Source traceability stays outside public/ so builds never publish local reference paths.
await mkdir(path.resolve('.runtime'), { recursive: true });
await writeFile(
  path.resolve('.runtime/game-sources.json'),
  JSON.stringify({ sprites: spriteSources, files: sources }, null, 1),
);
await removeStale(
  new Set([...copied.values(), '/game/fonts/game.woff2', ...Object.values(atlases).map(atlas => atlas.url)]),
);
await writeFile(
  path.join(output, 'catalog.json'),
  JSON.stringify({ characters: characters.map(({ id, name, preview }) => ({ id, name, preview })) }, null, 2),
);
console.log(
  `已准备 ${characters.length} 个角色、${visuals.length} 个大厅精灵、${objects.length} 个关卡对象；${Object.keys(packed).length} 个精灵打包为 ${Object.keys(atlases).length} 张图集，另有 ${copied.size} 个引用文件。`,
);
if (Object.keys(normalized).length)
  console.log(`源交付非有限数字已规范化为 null（颜色回退白色，几何仍严格校验）：${JSON.stringify(normalized)}`);
