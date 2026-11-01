import { BUILDINGS, type Building, type Placeable } from './defs';

// Struct-of-arrays grid. One building per tile (1x1 for now).
// Per-tile state is shared between building types; each system reads only
// the fields its building uses.
export class Grid {
  readonly w: number;
  readonly h: number;

  // Terrain
  readonly ore: Uint8Array;

  // Building
  readonly building: Uint8Array;
  readonly hp: Float32Array;
  readonly dir: Uint8Array; // 0..3, for directed buildings
  readonly cd: Int32Array; // turret fire cooldown / miner production timer
  readonly ammo: Uint16Array; // turrets

  // Belt contents: one item per tile, progress 0..BELT.ticksPerTile
  readonly item: Uint8Array;
  readonly itemProg: Uint16Array;

  /** Bumped on every structural change so dependents (flow field) know to rebuild. */
  version = 0;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    const n = w * h;
    this.ore = new Uint8Array(n);
    this.building = new Uint8Array(n);
    this.hp = new Float32Array(n);
    this.dir = new Uint8Array(n);
    this.cd = new Int32Array(n);
    this.ammo = new Uint16Array(n);
    this.item = new Uint8Array(n);
    this.itemProg = new Uint16Array(n);
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  /** Neighbour index in direction d, or -1 if off-grid. */
  step(i: number, d: number): number {
    const x = (i % this.w) + (d === 0 ? 1 : d === 2 ? -1 : 0);
    const y = ((i / this.w) | 0) + (d === 1 ? 1 : d === 3 ? -1 : 0);
    return this.inBounds(x, y) ? y * this.w + x : -1;
  }

  place(i: number, b: Exclude<Building, 0>, dir = 0): void {
    this.clear(i);
    this.building[i] = b;
    this.hp[i] = BUILDINGS[b].hp;
    this.dir[i] = dir & 3;
    this.version++;
  }

  remove(i: number): void {
    this.clear(i);
    this.version++;
  }

  isSolid(i: number): boolean {
    const b = this.building[i];
    return b !== 0 && BUILDINGS[b as Exclude<Building, 0>].solid;
  }

  isA(i: number, b: Placeable | 1): boolean {
    return this.building[i] === b;
  }

  private clear(i: number): void {
    this.building[i] = 0;
    this.hp[i] = 0;
    this.dir[i] = 0;
    this.cd[i] = 0;
    this.ammo[i] = 0;
    this.item[i] = 0;
    this.itemProg[i] = 0;
  }
}
