import { GAME_RULES } from './game-behavior.ts';
import type { Point } from './game-content.ts';

export interface RopeBody { position: Point; velocity: Point; mass: number }
/** Tension-only directional spring. Equal opposite forces conserve pair momentum. */
export class RopeModel {
  constructor(private readonly rules = GAME_RULES.rope) {}
  force(a: RopeBody, b: RopeBody): Point {
    const dx = b.position.x + this.rules.endpointB.x - a.position.x - this.rules.endpointA.x;
    const dy = b.position.y + this.rules.endpointB.y - a.position.y - this.rules.endpointA.y;
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length <= this.rules.restLength) return { x: 0, y: 0 };
    const nx = dx / length, ny = dy / length;
    const relative = (b.velocity.x - a.velocity.x) * nx + (b.velocity.y - a.velocity.y) * ny;
    const stiffness = this.rules.horizontalStiffness * nx * nx + this.rules.upwardStiffness * ny * ny;
    const magnitude = Math.min(this.rules.maxAcceleration * Math.min(a.mass, b.mass),
      Math.max(0, stiffness * (length - this.rules.restLength) + this.rules.damping * relative));
    return { x: nx * magnitude, y: ny * magnitude };
  }
}
