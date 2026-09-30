import type { InputState, PlayerProfile, WorldKind, WorldSnapshot } from '../shared/protocol.ts';
import type { Point } from '../shared/game-content.ts';

// The implementation is owned by shared/simulation.ts; this is its server boundary.
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
export type SimulationFactory = (kind: WorldKind) => Promise<GameSimulation>;
export const loadSimulation: SimulationFactory = async kind => {
  const source = '../shared/simulation.ts';
  const module = await import(source);
  return module.createSimulation(kind);
};
