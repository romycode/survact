import { BUILDINGS, type Building } from './defs';

// Infinite sparse grid. Only tiles with a building exist (Map keyed by packed
// coords). At this game's scale (hundreds of entities) a Map beats chunked
// typed arrays on simplicity and is plenty fast. Map iteration order is
// insertion order, so systems that iterate tiles stay deterministic.

const OFF = 32768;
const SPAN = 65536;

/** Pack tile coords (|x|,|y| < 32768) into one exact integer. */
export const key = (x: number, y: number): number => (y + OFF) * SPAN + (x + OFF);
export const kx = (k: number): number => (k % SPAN) - OFF;
export const ky = (k: number): number => Math.floor(k / SPAN) - OFF;

/** Neighbour key in direction d (0=E 1=S 2=W 3=N). Pure arithmetic. */
export const stepKey = (k: number, d: number): number =>
  d === 0 ? k + 1 : d === 1 ? k + SPAN : d === 2 ? k - 1 : k - SPAN;

export interface Tile {
  b: Exclude<Building, 0>;
  hp: number;
  dir: number; // 0..3 for directed buildings
  cd: number; // turret fire cooldown / miner & furnace production timer
  ammo: number; // turrets
  inp: number; // furnace input buffer
  out: number; // furnace output buffer
  item: number; // belts: Item id, 0 = empty
  prog: number; // belts: 0..BELT.ticksPerTile
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number; // inclusive
  y1: number;
}

export class Grid {
  readonly tiles = new Map<number, Tile>();
  /** Bumped on every structural change so dependents (flow field) know to rebuild. */
  version = 0;

  private boundsVersion = -1;
  private boundsCache: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };

  get(k: number): Tile | undefined {
    return this.tiles.get(k);
  }

  building(k: number): number {
    return this.tiles.get(k)?.b ?? 0;
  }

  isSolid(k: number): boolean {
    const t = this.tiles.get(k);
    return t !== undefined && BUILDINGS[t.b].solid;
  }

  place(k: number, b: Exclude<Building, 0>, dir = 0): void {
    this.tiles.set(k, { b, hp: BUILDINGS[b].hp, dir: dir & 3, cd: 0, ammo: 0, inp: 0, out: 0, item: 0, prog: 0 });
    this.version++;
  }

  remove(k: number): void {
    if (this.tiles.delete(k)) this.version++;
  }

  /** Bounding box of all buildings (cached per version). */
  bounds(): Rect {
    if (this.boundsVersion !== this.version) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const k of this.tiles.keys()) {
        const x = kx(k);
        const y = ky(k);
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
      this.boundsCache = x0 === Infinity ? { x0: 0, y0: 0, x1: 0, y1: 0 } : { x0, y0, x1, y1 };
      this.boundsVersion = this.version;
    }
    return this.boundsCache;
  }
}
