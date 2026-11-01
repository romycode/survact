import { BUILDINGS, Building } from './defs';

// Struct-of-arrays grid. One building per tile (1x1 for now).
export class Grid {
  readonly building: Uint8Array;
  readonly hp: Float32Array;
  /** Bumped on every structural change so dependents (flow field) know to rebuild. */
  version = 0;

  readonly w: number;
  readonly h: number;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.building = new Uint8Array(w * h);
    this.hp = new Float32Array(w * h);
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  place(i: number, b: Exclude<Building, 0>): void {
    this.building[i] = b;
    this.hp[i] = BUILDINGS[b].hp;
    this.version++;
  }

  remove(i: number): void {
    this.building[i] = Building.None;
    this.hp[i] = 0;
    this.version++;
  }
}
