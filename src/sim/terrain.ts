// Procedural terrain: a pure function of (seed, x, y), cached on first read.
//
// Iron comes in big, rich, spaced-out deposits rather than scattered specks:
// the world is cut into CELL×CELL cells and most cells hold one deposit with
// a noisy edge. Deposits further from the core are larger and richer, so
// expanding (and moving ore fast over distance) pays off. Each ore tile has a
// finite amount; the world tracks how much has been mined.
//
// Water comes from low-frequency noise and blocks building and enemies.
// Deposits override water so a deposit is never unusable.

import { ORE } from './defs';
import { key } from './grid';

const WATER_THRESHOLD = 0.7;

export const Ground = {
  Land: 0,
  Ore: 1,
  Water: 2,
} as const;
export type Ground = (typeof Ground)[keyof typeof Ground];

interface Deposit {
  cx: number;
  cy: number;
  r: number;
  /** Ore per tile at the centre. */
  rich: number;
}

export class Terrain {
  private readonly seed: number;
  private readonly ground = new Map<number, Ground>();
  private readonly amount = new Map<number, number>();
  private readonly forced = new Map<number, { g: Ground; amount: number }>();
  private readonly deposits = new Map<number, Deposit | null>();

  constructor(seed: number) {
    this.seed = seed | 0;
  }

  at(x: number, y: number): Ground {
    const k = key(x, y);
    const f = this.forced.get(k);
    if (f) return f.g;
    let g = this.ground.get(k);
    if (g === undefined) {
      const a = this.depositAmount(x, y);
      if (a > 0) {
        g = Ground.Ore;
        this.amount.set(k, a);
      } else {
        const w = 0.75 * this.noise(x / 11, y / 11, 2) + 0.25 * this.noise(x / 4, y / 4, 3);
        g = w > WATER_THRESHOLD ? Ground.Water : Ground.Land;
      }
      this.ground.set(k, g);
    }
    return g;
  }

  /** Initial ore on a tile (0 if not ore). */
  initialOre(x: number, y: number): number {
    if (this.at(x, y) !== Ground.Ore) return 0;
    const k = key(x, y);
    return this.forced.get(k)?.amount ?? this.amount.get(k) ?? 0;
  }

  water(x: number, y: number): boolean {
    return this.at(x, y) === Ground.Water;
  }

  /** Force a disc of ground (dry land around the core, the starter patch). */
  forceDisc(cx: number, cy: number, r: number, g: Ground, amount = 0): void {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (Math.hypot(x - cx, y - cy) <= r) this.forced.set(key(x, y), { g, amount });
      }
    }
  }

  // ---------------- deposits ----------------

  private deposit(cx: number, cy: number): Deposit | null {
    const ck = key(cx, cy);
    if (this.deposits.has(ck)) return this.deposits.get(ck)!;
    const C = ORE.cell;
    let d: Deposit | null = null;
    if (hash(this.seed ^ 0x51ed, cx, cy) < ORE.cellChance) {
      // Size and richness grow with distance from the core.
      const ox = (cx + 0.5) * C;
      const oy = (cy + 0.5) * C;
      const far = Math.min(1, Math.hypot(ox, oy) / ORE.richAtDistance);
      const r = ORE.minRadius + (ORE.maxRadius - ORE.minRadius) * (0.4 * hash(this.seed ^ 0x77, cx, cy) + 0.6 * far);
      const m = Math.ceil(r) + 2;
      const px = cx * C + m + hash(this.seed ^ 0x1234, cx, cy) * (C - 2 * m);
      const py = cy * C + m + hash(this.seed ^ 0x4321, cx, cy) * (C - 2 * m);
      // Keep the core's surroundings free: the starter patch covers early game.
      if (Math.hypot(px, py) > ORE.clearAroundCore + r) {
        const rich = ORE.baseRich * (0.7 + 0.6 * hash(this.seed ^ 0xbeef, cx, cy)) * (1 + far * ORE.richFarBonus);
        d = { cx: px, cy: py, r, rich };
      }
    }
    this.deposits.set(ck, d);
    return d;
  }

  private depositAmount(x: number, y: number): number {
    const C = ORE.cell;
    const d = this.deposit(Math.floor(x / C), Math.floor(y / C));
    if (!d) return 0;
    const dist = Math.hypot(x + 0.5 - d.cx, y + 0.5 - d.cy);
    // Noisy, blobby edge.
    const edge = d.r * (0.85 + 0.3 * this.noise(x / 4, y / 4, 4));
    if (dist > edge) return 0;
    const core = 1 - 0.6 * (dist / edge) ** 2; // richer in the middle
    return Math.round(d.rich * core);
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
