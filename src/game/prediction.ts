import type { ActorSnapshot, InputState, WorldSnapshot } from '../../shared/protocol.ts';
import type { GameContent } from '../../shared/game-content.ts';
import { GAME_RULES as R } from '../../shared/game-behavior.ts';
import { createWorld, type PredictionWorld, type Rapier } from '../../shared/world.ts';
import { reportClientError } from '../client/diagnostics';

export interface Pose {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  grounded: boolean;
}
export type InputSample = Omit<InputState, 'sequence'>;

let rapier: Promise<Rapier> | undefined;
// The physics engine is large; it streams in after first paint and prediction starts once ready.
const loadRapier = () =>
  (rapier ??= import('@dimforge/rapier2d-compat').then(async module => {
    await module.default.init();
    return module.default;
  }));
// Sequences stay monotonic across reconnects; the server resets its high-water mark per connection.
let sequence = 0;
const MAX_PENDING = 60,
  SNAP_DISTANCE = 400,
  CORRECTION_SECONDS = 0.1;
const pose = (actor: ActorSnapshot): Pose => ({
  x: actor.x,
  y: actor.y,
  vx: actor.vx,
  vy: actor.vy,
  facing: actor.facing,
  grounded: actor.grounded,
});

/**
 * Client-side prediction for the local player. Inputs are sampled and sent at the server's
 * fixed tick; the same world code simulates them immediately. Each snapshot rewinds to the
 * server state acknowledged by `ack` and replays inputs the server has not simulated yet.
 */
export class LocalPlayer {
  private engine?: Rapier;
  private world?: PredictionWorld;
  private worldKey = '';
  private pending: InputState[] = [];
  private accumulator = 0;
  private previous?: Pose;
  private current?: Pose;
  private correction = { x: 0, y: 0 };

  /** Resolves once physics is loaded; until then the own cat is drawn from snapshots. */
  readonly ready: Promise<void>;
  constructor(private readonly content: GameContent) {
    this.ready = loadRapier()
      .then(engine => {
        this.engine = engine;
      })
      .catch(error => {
        reportClientError('game.physics', error);
      });
  }

  /** Advances fixed ticks, sending one input per tick. Returns the pose to draw, if predicting. */
  frame(dt: number, read: () => InputSample, send: (input: InputState) => void, selfId: string): Pose | undefined {
    this.accumulator = Math.min(this.accumulator + dt, R.maxFrameTime);
    while (this.accumulator >= R.fixedStep) {
      this.accumulator -= R.fixedStep;
      const input = { ...read(), sequence: ++sequence };
      send(input);
      if (!this.world) continue;
      this.pending.push(input);
      if (this.pending.length > MAX_PENDING) this.pending.shift();
      this.simulate(selfId, input);
    }
    if (!this.world || !this.previous || !this.current) return undefined;
    const alpha = this.accumulator / R.fixedStep,
      decay = Math.exp(-dt / CORRECTION_SECONDS);
    this.correction.x *= decay;
    this.correction.y *= decay;
    return {
      ...this.current,
      x: this.previous.x + (this.current.x - this.previous.x) * alpha + this.correction.x,
      y: this.previous.y + (this.current.y - this.previous.y) * alpha + this.correction.y,
    };
  }

  /** Applies an authoritative snapshot: rewinds to it, then replays unacknowledged inputs. */
  reconcile(snapshot: WorldSnapshot, selfId: string) {
    const self = snapshot.players.find(player => player.id === selfId);
    if (!this.engine || !self || snapshot.won) {
      this.reset();
      return;
    }
    const key = `${snapshot.kind}:${snapshot.players.map(player => player.id).join(',')}`;
    if (key !== this.worldKey) {
      this.reset();
      this.world = createWorld(this.engine, snapshot.kind, this.content, selfId);
      for (const player of snapshot.players) this.world.addPlayer(player);
      this.worldKey = key;
    }
    const world = this.world!;
    for (const player of snapshot.players)
      if (player.id !== selfId) world.placeProxy(player.id, player.x, player.y, player.vx, player.vy);
    const ack = snapshot.ack ?? -1;
    const acknowledged = this.pending.filter(input => input.sequence <= ack).at(-1) ?? {
      x: 0,
      y: 0,
      jump: false,
      sequence: ack,
    };
    this.pending = this.pending.filter(input => input.sequence > ack);
    const before = this.current;
    world.restore(self, acknowledged);
    this.current = pose(self);
    for (const input of this.pending) this.simulate(selfId, input, false);
    if (!before || !this.previous) {
      this.previous = this.current;
      return;
    }
    // Keep the drawn position continuous and let the correction fade instead of popping.
    const dx = this.current.x - before.x,
      dy = this.current.y - before.y;
    if (Math.hypot(dx, dy) > SNAP_DISTANCE) {
      this.correction = { x: 0, y: 0 };
      this.previous = this.current;
      return;
    }
    this.correction.x -= dx;
    this.correction.y -= dy;
    this.previous = { ...this.previous, x: this.previous.x + dx, y: this.previous.y + dy };
  }

  dispose() {
    this.reset();
  }

  private simulate(selfId: string, input: InputState, advance = true) {
    this.world!.setInput(selfId, input);
    this.world!.step(R.fixedStep);
    const self = this.world!.snapshot().players.find(player => player.id === selfId);
    if (!self) return;
    if (advance) this.previous = this.current;
    this.current = pose(self);
  }

  private reset() {
    this.world?.dispose();
    this.world = undefined;
    this.worldKey = '';
    this.pending = [];
    this.previous = this.current = undefined;
    this.correction = { x: 0, y: 0 };
  }
}

/**
 * Other players are drawn a fixed delay behind the newest snapshot and interpolated between
 * the two snapshots around that time, which hides the 20 Hz update rate and network jitter.
 */
export class RemotePlayers {
  private buffer: { elapsed: number; players: Map<string, ActorSnapshot> }[] = [];
  private kind = '';
  private offset?: number;

  push(snapshot: WorldSnapshot, now: number) {
    const last = this.buffer.at(-1);
    if (snapshot.kind !== this.kind || (last && snapshot.elapsed < last.elapsed)) {
      this.buffer = [];
      this.offset = undefined;
      this.kind = snapshot.kind;
    }
    if (last && snapshot.elapsed === last.elapsed) return;
    this.buffer.push({
      elapsed: snapshot.elapsed,
      players: new Map(snapshot.players.map(player => [player.id, player])),
    });
    if (this.buffer.length > 30) this.buffer.shift();
    // Track the local-clock offset of the fastest-arriving snapshots; creep up slowly for drift.
    const sample = now - snapshot.elapsed;
    this.offset =
      this.offset === undefined || sample < this.offset ? sample : this.offset + (sample - this.offset) * 0.02;
  }

  sample(id: string, now: number): Pose | undefined {
    if (this.offset === undefined) return undefined;
    const time = now - this.offset - R.render.interpolationSeconds;
    let older, newer;
    for (const entry of this.buffer) {
      if (!entry.players.has(id)) continue;
      if (entry.elapsed <= time) older = entry;
      else {
        newer = entry;
        break;
      }
    }
    const a = older?.players.get(id),
      b = newer?.players.get(id);
    if (!a || !b) return (a ?? b) && pose((a ?? b)!);
    const t = (time - older!.elapsed) / (newer!.elapsed - older!.elapsed);
    if (Math.hypot(b.x - a.x, b.y - a.y) > R.render.maxInterpolationJump) return pose(t < 0.5 ? a : b);
    return {
      ...pose(b),
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      vx: a.vx + (b.vx - a.vx) * t,
      vy: a.vy + (b.vy - a.vy) * t,
    };
  }
}
