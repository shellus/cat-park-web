import type { CharacterOption } from './protocol.ts';

export interface Point {
  x: number;
  y: number;
}
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
export interface GameAtlas {
  url: string;
  width: number;
  height: number;
}
/** A sprite is a frame inside one atlas page; `frame` is its top-left pixel. */
export interface GameSprite {
  atlas: string;
  frame: Point;
  width: number;
  height: number;
  ppu: number;
  pivot: Point;
  border: { x: number; y: number; z: number; w: number };
}
/** Affine transform from PNG pixels into display coordinates (X right, Y down). */
export interface GameVisual {
  id: string;
  sprite: string;
  matrix: [number, number, number, number, number, number];
  tint: number;
  alpha: number;
  order: number;
}
export interface GameAnimation {
  name: string;
  duration: number;
  loop: boolean;
  frames: { time: number; node: string; sprite: string | null }[];
}
export interface GameCharacter extends CharacterOption {
  layers: GameVisual[];
  animations: GameAnimation[];
  atlases: string[];
}
export interface GameObject {
  id: string;
  name: string;
  type: number;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  sprite: string;
  /** Optional state sprite used by interactive objects after activation. */
  openedSprite?: string;
  parameters: Record<string, string>;
  tint: number;
}
export interface GameCollider {
  source: string;
  kind: 'box' | 'polyline';
  x: number;
  y: number;
  width?: number;
  height?: number;
  angle?: number;
  points?: Point[];
}
/** Scene and character `atlases` list the pages that must load before that part renders. */
export interface GameContent {
  version: 1;
  atlases: Record<string, GameAtlas>;
  sprites: Record<string, GameSprite>;
  characters: GameCharacter[];
  lobby: { visuals: GameVisual[]; colliders: GameCollider[]; bounds: Bounds; spawn: Point; atlases: string[] };
  challenge: {
    name: string;
    objects: GameObject[];
    rope: Record<string, string>;
    background: string;
    bounds: Bounds;
    atlases: string[];
  };
  audio: Record<string, string>;
}
