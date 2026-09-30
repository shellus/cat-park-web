import { GAME_RULES } from './game-behavior.ts';
import type { Point } from './game-content.ts';

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export interface RopeBody {
  position: Point;
  velocity: Point;
  mass: number;
}
/**
 * Spring between the two body centres: only beyond `restLength`, each end
 * is pulled by `stiffness × stretch` and loses `dampingPerStep` of the relative speed along the
 * rope every step. A rope never pushes; equal opposite forces conserve pair momentum.
 */
export class RopeModel {
  constructor(private readonly rules = GAME_RULES.rope) {}
  force(a: RopeBody, b: RopeBody, dt: number): Point {
    const dx = b.position.x - a.position.x,
      dy = b.position.y - a.position.y;
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length <= this.rules.restLength) return { x: 0, y: 0 };
    const nx = dx / length,
      ny = dy / length;
    const relative = (b.velocity.x - a.velocity.x) * nx + (b.velocity.y - a.velocity.y) * ny;
    const mass = Math.min(a.mass, b.mass);
    const magnitude = clamp(
      this.rules.stiffness * (length - this.rules.restLength) + ((this.rules.dampingPerStep * relative) / dt) * mass,
      0,
      this.rules.maxAcceleration * mass,
    );
    return { x: nx * magnitude, y: ny * magnitude };
  }
}
