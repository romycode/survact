// Procedural terrain: a pure function of (seed, x, y), cached on first read.
// Ore appears in blobby patches; water in larger lakes/rivers. Water blocks
// both building and enemy movement.

import { key } from './grid';

const ORE_THRESHOLD = 0.68;
const WATER_THRESHOLD = 0.7;

export const Ground = {
  Land: 0,
  Ore: 1,
  Water: 2,
} as const;
export type Ground = (typeof Ground)[keyof typeof Ground];

export class Terrain {
  private readonly seed: number;
  private readonly cache = new Map<number, number>();
  private readonly forced = new Map<number, number>();

  constructor(seed: number) {
    this.seed = seed | 0;
  }

  at(x: number, y: number): Ground {
    const k = key(x, y);
    const f = this.forced.get(k);
    if (f !== undefined) return f as Ground;
    let v = this.cache.get(k);
    if (v === undefined) {
      const w = 0.75 * this.noise(x / 11, y / 11, 2) + 0.25 * this.noise(x / 4, y / 4, 3);
      if (w > WATER_THRESHOLD) {
        v = Ground.Water;
      } else {
        const n = 0.7 * this.noise(x / 6, y / 6, 0) + 0.3 * this.noise(x / 2.5, y / 2.5, 1);
        v = n > ORE_THRESHOLD ? Ground.Ore : Ground.Land;
      }
      this.cache.set(k, v);
    }
    return v as Ground;
  }

  ore(x: number, y: number): boolean {
    return this.at(x, y) === Ground.Ore;
  }

  water(x: number, y: number): boolean {
    return this.at(x, y) === Ground.Water;
  }

  /** Force a disc of ground (starter patch, dry land around the core). */
  forceDisc(cx: number, cy: number, r: number, g: Ground, onlyIfWater = false): void {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (Math.hypot(x - cx, y - cy) > r) continue;
        if (onlyIfWater && !this.water(x, y)) continue;
        this.forced.set(key(x, y), g);
      }
    }
  }

  private noise(x: number, y: number, octave: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const s = this.seed + octave * 0x9e3779b9;
    const a = hash(s, ix, iy);
    const b = hash(s, ix + 1, iy);
    const c = hash(s, ix, iy + 1);
    const d = hash(s, ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
}

function hash(seed: number, x: number, y: number): number {
  let t = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed;
  t = Math.imul(t ^ (t >>> 15), 0x85ebca6b);
  t ^= t >>> 13;
  t = Math.imul(t, 0xc2b2ae35);
  t ^= t >>> 16;
  return (t >>> 0) / 4294967296;
}
