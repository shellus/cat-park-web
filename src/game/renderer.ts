import {
  Application,
  Assets,
  ColorMatrixFilter,
  Container,
  Graphics,
  Matrix,
  NineSliceSprite,
  Rectangle,
  Sprite,
  Text,
  Texture,
  TilingSprite,
} from 'pixi.js';
import type { ActorSnapshot, InputState, OfflinePlayer, WorldSnapshot } from '../../shared/protocol.ts';
import type { GameCharacter, GameContent, GameSprite, GameVisual } from '../../shared/game-content.ts';
import { GAME_RULES as R } from '../../shared/game-behavior.ts';
import { LocalPlayer, RemotePlayers, type InputSample, type Pose } from './prediction.ts';
import { reportClientError } from '../client/diagnostics';

interface ActorView {
  container: Container;
  layers: Map<string, Sprite>;
  label: Text;
  note: Text;
  marker: Graphics;
  character: GameCharacter;
  animation: string;
  animationTime: number;
  x: number;
  y: number;
}
/** Written by the renderer every frame so pointer input can map screen points to the world. */
export interface RenderView {
  cameraX: number;
  cameraY: number;
  zoom: number;
  width: number;
  height: number;
  self?: { x: number; y: number };
  target?: { x: number; y: number } | null;
}
interface RenderState {
  world: WorldSnapshot | null;
  selfId: string;
  readInput: () => InputSample;
  sendInput: (input: InputState) => void;
  /** Offline players: last-seen time for everyone offline, and cats left standing in the lobby. */
  lastSeen: Map<string, number>;
  offline: OfflinePlayer[];
  view: RenderView;
}
export function lastSeenText(at: number, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return '刚刚在线';
  if (minutes < 60) return `${minutes}分钟前在线`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}小时前在线`;
  return `${Math.floor(minutes / 1440)}天前在线`;
}
let contentPromise: Promise<GameContent> | undefined;
function loadContent(): Promise<GameContent> {
  return (contentPromise ??= fetch('/game/content.json')
    .then(async response => {
      if (!response.ok) throw new Error('游戏素材未准备，请运行资源准备命令后重试');
      const data = (await response.json()) as GameContent;
      if (data.version !== 1 || !data.characters.length || !data.lobby.visuals.length)
        throw new Error('游戏素材目录不完整');
      return data;
    })
    .catch(error => {
      contentPromise = undefined;
      throw error;
    }));
}
const affine = (values: number[]) => new Matrix(...(values as [number, number, number, number, number, number]));
const frames = new WeakMap<GameSprite, Texture>();
/** Atlas pages load by scene; this only runs for sprites whose page is already loaded. */
function atlasTexture(content: GameContent, item: GameSprite): Texture {
  let result = frames.get(item);
  if (!result) {
    const page = Assets.get<Texture>(content.atlases[item.atlas].url);
    result = new Texture({
      source: page.source,
      frame: new Rectangle(item.frame.x, item.frame.y, item.width, item.height),
    });
    frames.set(item, result);
  }
  return result;
}

export function mountGameRenderer(
  host: HTMLElement,
  state: () => RenderState,
  status: (message: string | null, error?: boolean) => void,
): () => void {
  const app = new Application();
  let cancelled = false,
    initialized = false,
    disposeLocal: (() => void) | undefined;
  const observer = new ResizeObserver(() => {
    if (initialized && !cancelled) app.renderer.resize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight));
  });
  observer.observe(host);
  void (async () => {
    status('正在载入公园素材…');
    const content = await loadContent();
    const texture = (item: GameSprite) => atlasTexture(content, item);
    const loaded = new Set<string>(),
      loading = new Set<string>();
    // Returns true once every page is ready; otherwise starts loading the missing pages.
    const ensure = (ids: string[]) => {
      const missing = ids.filter(id => !loaded.has(id));
      for (const id of missing)
        if (!loading.has(id)) {
          loading.add(id);
          void Assets.load(content.atlases[id].url)
            .then(() => loaded.add(id))
            .catch(error => reportClientError('game.asset', error, { url: content.atlases[id].url }))
            .finally(() => loading.delete(id));
        }
      return missing.length === 0;
    };
    const characterAtlases = (id: string) =>
      (content.characters.find(c => c.id === id) ?? content.characters[0]).atlases;
    // First paint waits for the current scene and visible characters only; others stream in later.
    const initial = state().world;
    const first = [
      ...new Set([
        ...content[initial?.kind ?? 'lobby'].atlases,
        ...(initial?.players ?? []).flatMap(p => characterAtlases(p.characterId)),
        ...content.characters[0].atlases,
      ]),
    ];
    let done = 0;
    await Promise.all(
      first.map(id =>
        Assets.load(content.atlases[id].url).then(() => {
          loaded.add(id);
          done++;
          if (!cancelled) status(`正在载入公园素材 ${Math.round((done / first.length) * 100)}%`);
        }),
      ),
    );
    if (cancelled) return;
    await app.init({
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
      background: '#b9dca9',
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      preference: 'webgl',
    });
    initialized = true;
    if (cancelled) {
      app.destroy({ removeView: true }, { children: true });
      return;
    }
    app.canvas.setAttribute('aria-label', '萌猫公园游戏场景');
    app.canvas.style.display = 'block';
    host.appendChild(app.canvas);
    const background = new TilingSprite({ texture: Texture.EMPTY, width: app.screen.width, height: app.screen.height });
    app.stage.addChild(background);
    const camera = new Container(),
      scenery = new Container(),
      items = new Container(),
      ropeGraphics = new Graphics(),
      actors = new Container(),
      targetMarker = new Graphics();
    camera.addChild(scenery, items, targetMarker, ropeGraphics, actors);
    app.stage.addChild(camera);
    const grey = new ColorMatrixFilter();
    grey.desaturate();
    const local = new LocalPlayer(content),
      remote = new RemotePlayers();
    disposeLocal = () => local.dispose();
    let lastWorld: WorldSnapshot | null = null;
    const lobbySprites: { sprite: Sprite; visual: GameVisual; radius: number }[] = [];
    const itemSprites = new Map<string, Sprite | NineSliceSprite>();
    const actorViews = new Map<string, ActorView>();
    let currentKind = '',
      cameraX = 0,
      cameraY = 0,
      hasCamera = false;
    function putVisual(v: GameVisual): Sprite {
      const item = content.sprites[v.sprite],
        result = new Sprite(texture(item));
      result.anchor.set(item.pivot.x, 1 - item.pivot.y);
      result.setFromMatrix(affine(v.matrix));
      result.tint = v.tint;
      result.alpha = v.alpha;
      scenery.addChild(result);
      return result;
    }
    function buildScene(kind: string) {
      scenery.removeChildren().forEach(c => c.destroy());
      items.removeChildren().forEach(c => c.destroy());
      lobbySprites.length = 0;
      itemSprites.clear();
      hasCamera = false;
      currentKind = kind;
      background.visible = kind === 'challenge';
      if (kind === 'challenge') background.texture = texture(content.sprites[content.challenge.background]);
      if (kind === 'lobby')
        for (const v of content.lobby.visuals) {
          const item = content.sprites[v.sprite];
          lobbySprites.push({
            sprite: putVisual(v),
            visual: v,
            radius: Math.max(
              item.width * Math.hypot(v.matrix[0], v.matrix[1]),
              item.height * Math.hypot(v.matrix[2], v.matrix[3]),
            ),
          });
        }
      else
        for (const object of content.challenge.objects) {
          const source = content.sprites[object.sprite],
            border = source.border;
          const result =
            object.type === 2 && border.x + border.y + border.z + border.w > 0
              ? new NineSliceSprite({
                  texture: texture(source),
                  leftWidth: border.x,
                  rightWidth: border.z,
                  topHeight: border.w,
                  bottomHeight: border.y,
                  width: object.width,
                  height: object.height,
                })
              : new Sprite(texture(source));
          result.anchor.set(source.pivot.x, 1 - source.pivot.y);
          result.width = object.width;
          result.height = object.height;
          result.position.set(object.x, -object.y);
          result.rotation = -object.angle;
          result.tint = object.tint;
          (object.type === 2 ? scenery : items).addChild(result);
          itemSprites.set(object.id, result);
        }
    }
    function makeActor(actor: ActorSnapshot): ActorView {
      const character = content.characters.find(c => c.id === actor.characterId) ?? content.characters[0];
      const container = new Container(),
        layers = new Map<string, Sprite>();
      const marker = new Graphics();
      container.addChild(marker);
      for (const layer of character.layers) {
        const s = content.sprites[layer.sprite],
          picture = new Sprite(texture(s));
        picture.anchor.set(s.pivot.x, 1 - s.pivot.y);
        picture.setFromMatrix(affine(layer.matrix));
        container.addChild(picture);
        layers.set(layer.id, picture);
      }
      const label = new Text({
        text: actor.nickname,
        style: {
          fontFamily: 'GameFont, Microsoft YaHei, sans-serif',
          fontSize: 25,
          fontWeight: '600',
          fill: '#273b34',
          stroke: { color: '#ffffff', width: 5 },
          align: 'center',
        },
        resolution: 2,
      });
      label.anchor.set(0.5, 1);
      label.y = -90;
      container.addChild(label);
      const note = new Text({
        text: '',
        style: {
          fontFamily: 'Microsoft YaHei, PingFang SC, sans-serif',
          fontSize: 19,
          fill: '#4f5b55',
          stroke: { color: '#ffffff', width: 4 },
          align: 'center',
        },
        resolution: 2,
      });
      note.anchor.set(0.5, 1);
      note.y = -122;
      note.visible = false;
      container.addChild(note);
      actors.addChild(container);
      return {
        container,
        layers,
        label,
        note,
        marker,
        character,
        animation: '',
        animationTime: 0,
        x: actor.x,
        y: actor.y,
      };
    }
    app.ticker.add(ticker => {
      const { world, selfId, readInput, sendInput, lastSeen, offline, view: shared } = state();
      if (!world) {
        status('正在连接公共大厅…');
        return;
      }
      status(null);
      const dt = Math.min(ticker.deltaMS / 1000, 0.1),
        now = performance.now() / 1000;
      if (world !== lastWorld) {
        lastWorld = world;
        remote.push(world, now);
        local.reconcile(world, selfId);
      }
      const predicted = local.frame(dt, readInput, sendInput, selfId);
      if (world.kind !== currentKind) {
        if (!ensure(content[world.kind].atlases)) {
          status('正在载入关卡素材…');
          return;
        }
        buildScene(world.kind);
      }
      // Offline cats are drawn where they were left; they have no body and nothing collides with them.
      const standing: ActorSnapshot[] =
        world.kind === 'lobby'
          ? offline
              .filter(p => !world.players.some(a => a.id === p.id))
              .map(p => ({ ...p, vx: 0, vy: 0, facing: 1, grounded: true }))
          : [];
      const shownActors = [...world.players, ...standing],
        wallClock = Date.now();
      // Cats that never moved share the spawn point; label only the most recent in each crowd.
      const crowded = new Set<string>(),
        labelled: ActorSnapshot[] = [];
      for (const actor of [...standing].sort((a, b) => (lastSeen.get(b.id) ?? 0) - (lastSeen.get(a.id) ?? 0))) {
        if (labelled.some(other => Math.abs(other.x - actor.x) < 150 && Math.abs(other.y - actor.y) < 80))
          crowded.add(actor.id);
        else labelled.push(actor);
      }
      const live = new Set(shownActors.map(p => p.id));
      for (const [id, view] of actorViews)
        if (!live.has(id)) {
          view.container.destroy({ children: true });
          actorViews.delete(id);
        }
      for (const actor of shownActors) {
        if (!ensure(characterAtlases(actor.characterId))) continue;
        let view = actorViews.get(actor.id);
        if (view && view.character.id !== actor.characterId) {
          view.container.destroy({ children: true });
          actorViews.delete(actor.id);
          view = undefined;
        }
        if (!view) {
          view = makeActor(actor);
          actorViews.set(actor.id, view);
        }
        // Own cat: predicted locally. Others: interpolated slightly in the past between snapshots.
        const shown: Pose = (actor.id === selfId && predicted) || remote.sample(actor.id, now) || actor;
        view.x = shown.x;
        view.y = shown.y;
        view.container.position.set(view.x, -view.y);
        view.label.text = actor.nickname;
        view.label.visible = !crowded.has(actor.id);
        const seen = actor.id === selfId ? undefined : lastSeen.get(actor.id);
        view.note.visible = seen !== undefined && !crowded.has(actor.id);
        if (seen !== undefined) view.note.text = lastSeenText(seen, wallClock);
        const filters = seen !== undefined ? [grey] : [];
        if (view.container.filters?.length !== filters.length) {
          view.container.filters = filters;
          view.container.alpha = filters.length ? 0.62 : 1;
        }
        const desired =
          !shown.grounded && world.kind === 'challenge'
            ? 'Jump'
            : Math.hypot(shown.vx, shown.vy) > 55
              ? 'Move'
              : 'Idle';
        if (view.animation !== desired) {
          view.animation = desired;
          view.animationTime = 0;
        } else view.animationTime += dt;
        const clip = view.character.animations.find(a => a.name === desired) ?? view.character.animations[0];
        const time =
          clip.loop && clip.duration > 0
            ? view.animationTime % clip.duration
            : Math.min(view.animationTime, clip.duration);
        const selected = new Map<string, string | null>();
        for (const frame of clip.frames) if (frame.time <= time + 1e-5) selected.set(frame.node, frame.sprite);
        for (const layer of view.character.layers) {
          const picture = view.layers.get(layer.id)!,
            frameSprite = selected.has(layer.id) ? selected.get(layer.id) : layer.sprite;
          picture.visible = frameSprite !== null;
          if (!frameSprite) continue;
          const s = content.sprites[frameSprite];
          picture.texture = texture(s);
          picture.anchor.set(s.pivot.x, 1 - s.pivot.y);
          const matrix = [...layer.matrix];
          matrix[0] *= shown.facing;
          matrix[1] *= shown.facing;
          matrix[4] *= shown.facing;
          picture.setFromMatrix(affine(matrix));
          picture.tint = layer.tint;
        }
        const color = /^#[\da-f]{6}$/i.test(actor.color) ? actor.color : '#f5cb62';
        view.marker
          .clear()
          .ellipse(0, R.player.halfHeight + 5, 48, 12)
          .fill({ color, alpha: 0.55 });
        if (actor.id === selfId)
          view.marker.ellipse(0, R.player.halfHeight + 5, 51, 15).stroke({ color: '#ffffff', width: 4, alpha: 0.9 });
        view.container.zIndex = -view.y;
      }
      actors.sortableChildren = world.kind === 'lobby';
      ropeGraphics.clear();
      for (const connection of world.ropes) {
        const a = actorViews.get(connection.a),
          b = actorViews.get(connection.b);
        if (!a || !b) continue;
        const x1 = a.x + R.rope.endpointA.x,
          y1 = -a.y - R.rope.endpointA.y;
        const x2 = b.x + R.rope.endpointB.x,
          y2 = -b.y - R.rope.endpointB.y;
        const slack = Math.max(0, R.rope.restLength - Math.hypot(x2 - x1, y2 - y1)) * 0.2;
        ropeGraphics
          .moveTo(x1, y1)
          .quadraticCurveTo((x1 + x2) / 2, (y1 + y2) / 2 + slack, x2, y2)
          .stroke({ color: '#66594b', width: 7 });
        ropeGraphics
          .moveTo(x1, y1 - 1)
          .quadraticCurveTo((x1 + x2) / 2, (y1 + y2) / 2 + slack - 1, x2, y2 - 1)
          .stroke({ color: '#e5ca8d', width: 3 });
      }
      for (const object of content.challenge.objects) {
        const picture = itemSprites.get(object.id);
        if (!picture) continue;
        picture.visible = !world.collectedStars.includes(object.id);
        if (object.type === 3 && object.openedSprite) {
          const stateSprite = world.doorOpen ? object.openedSprite : object.sprite;
          const item = content.sprites[stateSprite];
          const nextTexture = texture(item);
          if (picture.texture !== nextTexture) {
            picture.texture = nextTexture;
            picture.anchor.set(item.pivot.x, 1 - item.pivot.y);
            picture.width = object.width;
            picture.height = object.height;
          }
        }
        if (object.type === 4) {
          const owner = world.keyOwnerId && actorViews.get(world.keyOwnerId);
          picture.position.set(owner ? owner.x : object.x, owner ? -owner.y - 140 : -object.y);
        }
      }
      const focus = actorViews.get(selfId) ?? (actorViews.values().next().value as ActorView | undefined);
      // Exposes the drawn own position for browser tests and latency diagnostics.
      const own = actorViews.get(selfId);
      if (own) {
        app.canvas.dataset.selfX = own.x.toFixed(1);
        app.canvas.dataset.selfY = own.y.toFixed(1);
        app.canvas.dataset.predicted = String(!!predicted);
      }
      app.canvas.dataset.offlineIds = standing.map(actor => actor.id).join(' ');
      targetMarker.clear();
      if (shared.target)
        targetMarker
          .ellipse(shared.target.x, -shared.target.y, 34, 11)
          .stroke({ color: '#ffffff', width: 5, alpha: 0.85 });
      if (focus) {
        const targetY = -focus.y - (world.kind === 'challenge' ? 110 : 0);
        if (!hasCamera) {
          cameraX = focus.x;
          cameraY = targetY;
          hasCamera = true;
        }
        const blend = 1 - Math.exp(-dt * 5);
        cameraX += (focus.x - cameraX) * blend;
        cameraY += (targetY - cameraY) * blend;
      }
      const baseZoom = world.kind === 'lobby' ? R.render.lobbyZoom : R.render.challengeZoom;
      const zoom = baseZoom * Math.min(1, Math.max(0.67, app.screen.width / 1000));
      camera.scale.set(zoom);
      camera.position.set(app.screen.width / 2 - cameraX * zoom, app.screen.height / 2 - cameraY * zoom);
      Object.assign(shared, {
        cameraX,
        cameraY,
        zoom,
        width: app.screen.width,
        height: app.screen.height,
        self: own ? { x: own.x, y: own.y } : undefined,
      });
      background.width = app.screen.width;
      background.height = app.screen.height;
      const halfWidth = app.screen.width / zoom / 2,
        halfHeight = app.screen.height / zoom / 2;
      for (const { sprite: picture, visual: v, radius } of lobbySprites)
        picture.visible =
          Math.abs(v.matrix[4] - cameraX) < halfWidth + radius && Math.abs(v.matrix[5] - cameraY) < halfHeight + radius;
    });
  })().catch(error => {
    if (!cancelled) {
      reportClientError('game.renderer', error);
      status(error instanceof Error ? error.message : '游戏画面加载失败', true);
    }
  });
  return () => {
    cancelled = true;
    observer.disconnect();
    disposeLocal?.();
    if (initialized) app.destroy({ removeView: true }, { children: true });
  };
}
