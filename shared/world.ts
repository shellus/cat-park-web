import type { RigidBody, Collider } from '@dimforge/rapier2d-compat';
import type { ActorSnapshot, InputState, PlayerProfile, WorldKind, WorldSnapshot } from './protocol.ts';
import type { GameContent, Point } from './game-content.ts';
import { GAME_RULES as R } from './game-behavior.ts';
import { RopeModel } from './game-rope.ts';

export interface GameSimulation {
  /** Places a new player at `at`, or at the next free spawn slot. */
  addPlayer(profile: PlayerProfile, at?: Point): void;
  removePlayer(id: string): void;
  updateProfile(profile: PlayerProfile): void;
  setInput(id: string, input: InputState): void;
  step(dt: number): void;
  snapshot(): WorldSnapshot;
  dispose(): void;
}
/**
 * Browser prediction uses the same world with one locally controlled player. Every other
 * player is a kinematic proxy placed at its displayed position, and shared game state
 * (key, stars, door, win) stays server-owned.
 */
export interface PredictionWorld extends GameSimulation {
  /** Rewinds the controlled player to an authoritative server state before replaying inputs. */
  restore(state: ActorSnapshot, lastInput: InputState): void;
  placeProxy(id: string, x: number, y: number, vx: number, vy: number): void;
}
export type Rapier = typeof import('@dimforge/rapier2d-compat').default;
interface Player {
  profile: PlayerProfile;
  body: RigidBody;
  collider: Collider;
  input: InputState;
  facing: number;
  grounded: boolean;
  jumpQueuedUntil: number;
  lastGrounded: number;
  checkpoint: Point;
  proxy: boolean;
}
const S = R.sourceUnitsPerPhysicsUnit;
const emptyInput = (): InputState => ({ x: 0, y: 0, jump: false, sequence: -1 });
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const approach = (value: number, target: number, change: number) => value + clamp(target - value, -change, change);

export function createWorld(RAPIER: Rapier, kind: WorldKind, content: GameContent): GameSimulation;
export function createWorld(
  RAPIER: Rapier,
  kind: WorldKind,
  content: GameContent,
  predictedId: string,
): PredictionWorld;
export function createWorld(
  RAPIER: Rapier,
  kind: WorldKind,
  content: GameContent,
  predictedId?: string,
): PredictionWorld {
  const world = new RAPIER.World({ x: 0, y: kind === 'challenge' ? R.challenge.gravity / S : 0 });
  world.timestep = R.fixedStep;
  const players = new Map<string, Player>();
  const rope = new RopeModel();
  let tick = 0,
    elapsed = 0,
    accumulator = 0,
    disposed = false,
    keyOwnerId: string | null = null,
    doorOpen = false,
    won = false;
  const collectedStars = new Set<string>();
  if (kind === 'challenge') {
    for (const object of content.challenge.objects.filter(o => o.type === 2)) {
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(object.width / S / 2, object.height / S / 2)
          .setTranslation(object.x / S, object.y / S)
          .setRotation(object.angle)
          .setFriction(R.player.friction),
      );
    }
  } else {
    for (const shape of content.lobby.colliders) {
      if (shape.kind === 'box') {
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(shape.width! / S / 2, shape.height! / S / 2)
            .setTranslation(shape.x / S, shape.y / S)
            .setRotation(shape.angle ?? 0),
        );
      } else if (shape.points && shape.points.length > 2) {
        const points = [...shape.points, shape.points[0]];
        const vertices = new Float32Array(points.flatMap(p => [(p.x + shape.x) / S, (p.y + shape.y) / S]));
        world.createCollider(RAPIER.ColliderDesc.polyline(vertices));
      }
    }
  }
  function position(player: Player): Point {
    const p = player.body.translation();
    return { x: p.x * S, y: p.y * S };
  }
  function velocity(player: Player): Point {
    const v = player.body.linvel();
    return { x: v.x * S, y: v.y * S };
  }
  function isGrounded(player: Player): boolean {
    const p = player.body.translation();
    // Three foot rays avoid side-wall contacts counting as a floor; exclude the whole own body.
    return [-0.3, 0, 0.3].some(x => {
      const hit = world.castRay(
        new RAPIER.Ray({ x: p.x + x, y: p.y - R.player.halfHeight / S + 0.04 }, { x: 0, y: -1 }),
        0.11,
        false,
        undefined,
        undefined,
        player.collider,
        player.body,
      );
      return !!hit;
    });
  }
  function fixedStep() {
    tick++;
    elapsed = tick * R.fixedStep;
    for (const player of players.values()) {
      if (player.proxy) continue;
      const p = position(player),
        v = velocity(player);
      if (player.input.x) player.facing = Math.sign(player.input.x);
      if (kind === 'lobby') {
        const length = Math.max(1, Math.hypot(player.input.x, player.input.y));
        const vx = approach(v.x, (player.input.x / length) * R.lobby.speed, R.lobby.acceleration * R.fixedStep);
        const vy = approach(v.y, (player.input.y / length) * R.lobby.speed, R.lobby.acceleration * R.fixedStep);
        player.body.setLinvel({ x: vx / S, y: vy / S }, true);
        const bounds = content.lobby.bounds;
        if (p.x < bounds.minX || p.x > bounds.maxX || p.y < bounds.minY || p.y > bounds.maxY) {
          player.body.setTranslation(
            {
              x: clamp(p.x, bounds.minX + 80, bounds.maxX - 80) / S,
              y: clamp(p.y, bounds.minY + 80, bounds.maxY - 80) / S,
            },
            true,
          );
        }
        continue;
      }
      player.grounded = isGrounded(player) && v.y <= 70;
      if (player.grounded) {
        player.lastGrounded = elapsed;
        // Checkpoints only on real stage platforms, never another player's head.
        if (
          content.challenge.objects.some(
            o =>
              o.type === 2 &&
              Math.abs(p.y - R.player.halfHeight - (o.y + o.height / 2)) < 15 &&
              p.x > o.x - o.width / 2 + 50 &&
              p.x < o.x + o.width / 2 - 50,
          )
        )
          player.checkpoint = p;
      }
      const acceleration = player.grounded ? R.challenge.groundAcceleration : R.challenge.airAcceleration;
      let vy = v.y;
      if (player.jumpQueuedUntil >= elapsed && !won) {
        if (player.grounded || elapsed - player.lastGrounded <= R.challenge.coyoteTime) {
          vy = R.challenge.jumpSpeed;
          player.lastGrounded = -Infinity;
          player.grounded = false;
        }
        player.jumpQueuedUntil = -Infinity;
      }
      const target = won ? 0 : player.input.x * R.challenge.speed;
      player.body.setLinvel(
        {
          x: approach(v.x, target, acceleration * R.fixedStep) / S,
          y: clamp(vy, -R.player.maxSpeed, R.player.maxSpeed) / S,
        },
        true,
      );
    }
    if (kind === 'challenge') {
      const ordered = [...players.values()];
      for (let i = 1; i < ordered.length; i++) {
        const a = ordered[i - 1],
          b = ordered[i];
        const force = rope.force(
          { position: position(a), velocity: velocity(a), mass: R.player.mass },
          { position: position(b), velocity: velocity(b), mass: R.player.mass },
        );
        const impulse = { x: (force.x / S) * R.fixedStep, y: (force.y / S) * R.fixedStep };
        a.body.applyImpulse(impulse, true);
        b.body.applyImpulse({ x: -impulse.x, y: -impulse.y }, true);
      }
    }
    world.step();
    for (const player of players.values()) {
      if (player.proxy) continue;
      const p = position(player);
      if (
        !Number.isFinite(p.x + p.y) ||
        (kind === 'challenge' && (p.y < R.challenge.deathY || Math.abs(p.x) > 15000))
      ) {
        player.body.setTranslation({ x: player.checkpoint.x / S, y: (player.checkpoint.y + 10) / S }, true);
        player.body.setLinvel({ x: 0, y: 0 }, true);
        player.jumpQueuedUntil = -Infinity;
        if (keyOwnerId === player.profile.id) keyOwnerId = null;
      }
      if (kind !== 'challenge' || won || predictedId) continue;
      for (const object of content.challenge.objects) {
        const distance = Math.hypot(p.x - object.x, p.y - object.y);
        if (object.type === 4 && !keyOwnerId && distance < R.challenge.keyRadius) keyOwnerId = player.profile.id;
        if ((object.type === 200 || object.type === 300) && distance < R.challenge.starRadius)
          collectedStars.add(object.id);
      }
    }
    const exit = content.challenge.objects.find(o => o.type === 3);
    if (predictedId) return;
    if (kind === 'challenge' && keyOwnerId && exit && !doorOpen) {
      const holder = players.get(keyOwnerId);
      if (holder) {
        const p = position(holder);
        doorOpen = Math.hypot(p.x - exit.x, p.y - exit.y) <= R.challenge.exitRadius;
      }
    }
    if (kind === 'challenge' && players.size >= 2 && doorOpen && exit) {
      won = [...players.values()].every(player => {
        const p = position(player);
        return Math.hypot(p.x - exit.x, p.y - exit.y) <= R.challenge.exitRadius;
      });
    }
  }
  const api: PredictionWorld = {
    addPlayer(profile, at) {
      if (disposed) throw new Error('模拟已销毁');
      if (players.has(profile.id)) {
        api.updateProfile(profile);
        return;
      }
      const spawn = kind === 'lobby' ? content.lobby.spawn : R.challenge.spawn;
      const spacing = kind === 'lobby' ? R.lobby.spawnSpacing : R.challenge.spawnSpacing;
      const p = at ?? {
        x: spawn.x + (players.size % 6) * spacing,
        y: spawn.y + (kind === 'lobby' ? Math.floor(players.size / 6) * spacing : 0),
      };
      const proxy = !!predictedId && profile.id !== predictedId;
      const body = world.createRigidBody(
        (proxy ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic())
          .setTranslation(p.x / S, p.y / S)
          .lockRotations()
          .setCcdEnabled(!proxy),
      );
      const collider = world.createCollider(
        RAPIER.ColliderDesc.cuboid(R.player.halfWidth / S, R.player.halfHeight / S)
          .setMass(R.player.mass)
          .setFriction(R.player.friction)
          .setRestitution(0),
        body,
      );
      players.set(profile.id, {
        profile: { ...profile },
        body,
        collider,
        input: emptyInput(),
        facing: 1,
        grounded: false,
        jumpQueuedUntil: -Infinity,
        lastGrounded: -Infinity,
        checkpoint: p,
        proxy,
      });
    },
    removePlayer(id) {
      const p = players.get(id);
      if (p) {
        world.removeRigidBody(p.body);
        players.delete(id);
        if (keyOwnerId === id) keyOwnerId = null;
      }
    },
    updateProfile(profile) {
      const p = players.get(profile.id);
      if (p) p.profile = { ...profile };
    },
    setInput(id, input) {
      const p = players.get(id);
      if (!p || disposed) return;
      // Connections are ordered by the room transport; sequence may restart after reconnect.
      if (![input.x, input.y, input.sequence].every(Number.isFinite)) return;
      if (input.jump && !p.input.jump) p.jumpQueuedUntil = elapsed + R.challenge.jumpBuffer;
      p.input = { x: clamp(input.x, -1, 1), y: clamp(input.y, -1, 1), jump: !!input.jump, sequence: input.sequence };
    },
    step(dt) {
      if (disposed || !Number.isFinite(dt) || dt <= 0) return;
      accumulator += Math.min(dt, R.maxFrameTime);
      while (accumulator + 1e-9 >= R.fixedStep) {
        fixedStep();
        accumulator -= R.fixedStep;
      }
    },
    snapshot() {
      const ids = [...players.keys()];
      return {
        kind,
        tick,
        elapsed,
        keyOwnerId,
        collectedStars: [...collectedStars],
        doorOpen,
        won,
        ropes: kind === 'challenge' ? ids.slice(1).map((b, i) => ({ a: ids[i], b })) : [],
        players: [...players.values()].map(p => ({
          ...p.profile,
          ...position(p),
          vx: velocity(p).x,
          vy: velocity(p).y,
          facing: p.facing,
          grounded: kind === 'lobby' || p.grounded,
        })),
      };
    },
    restore(state, lastInput) {
      const p = players.get(state.id);
      if (!p || p.proxy) return;
      p.body.setTranslation({ x: state.x / S, y: state.y / S }, true);
      p.body.setLinvel({ x: state.vx / S, y: state.vy / S }, true);
      p.facing = state.facing;
      p.grounded = state.grounded;
      p.lastGrounded = state.grounded ? elapsed : -Infinity;
      p.jumpQueuedUntil = -Infinity;
      // Keeps jump edge detection aligned with the input the server applied last.
      p.input = { ...lastInput };
    },
    placeProxy(id, x, y, vx, vy) {
      const p = players.get(id);
      if (!p?.proxy) return;
      p.body.setTranslation({ x: x / S, y: y / S }, true);
      p.body.setLinvel({ x: vx / S, y: vy / S }, true);
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        players.clear();
        world.free();
      }
    },
  };
  return api;
}
