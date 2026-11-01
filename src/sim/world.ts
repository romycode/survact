// Simulation core. Pure: no DOM, no rendering, no wall-clock time.
// Everything changes through apply(cmd) or tick(), so a run is reproducible
// from (seed, command log) — useful for replays, debugging and tests.
//
// The world is infinite (sparse grid + procedural terrain). The fight is
// bounded: the flow field covers base + spawn points + padding.

import {
  BELT,
  BUILDINGS,
  Building,
  ECONOMY,
  ENEMY,
  FURNACE,
  Item,
  MAP,
  MINER,
  TURRET,
  costEntries,
  spawnPointCount,
  waveSize,
  type Cost,
  type Inventory,
  type Placeable,
  type Resource,
} from './defs';
import { FlowField, NO_NEXT } from './flowfield';
import { Grid, key, kx, ky, stepKey, type Rect } from './grid';
import { Rng } from './rng';
import { Ground, Terrain } from './terrain';

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export type Phase = 'build' | 'wave' | 'lost';

export type Command =
  | { type: 'place'; x: number; y: number; building: Placeable; dir?: number }
  /** Set facing; without dir, rotate clockwise. */
  | { type: 'rotate'; x: number; y: number; dir?: number }
  | { type: 'remove'; x: number; y: number }
  | { type: 'startWave' };

export type PlaceError = 'phase' | 'water' | 'occupied' | 'no-ore' | 'reach' | 'cost';

export interface Enemy {
  id: number;
  x: number; // tile units, centre of tile (tx,ty) is (tx+0.5, ty+0.5)
  y: number;
  prevX: number;
  prevY: number;
  tile: number; // key
  hp: number;
  maxHp: number;
  attackCd: number;
}

export interface Shot {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  ttl: number;
}

const SPAWN_INTERVAL_TICKS = 24;

export class World {
  readonly grid = new Grid();
  readonly terrain: Terrain;
  readonly flow: FlowField;
  readonly rng: Rng;
  readonly coreKey = key(0, 0);

  phase: Phase = 'build';
  wave = 0;
  tickCount = 0;
  readonly inv: Inventory = { ...ECONOMY.start };

  enemies: Enemy[] = [];
  shots: Shot[] = [];

  /** Spawn tiles for the current/next wave (keys). Visible during build. */
  spawns: number[] = [];

  private spawnAngles: number[] = [];
  private anglesVersion = 0;
  private flowVersion = -1;
  private flowAnglesVersion = -1;
  private nextEnemyId = 1;
  private toSpawn = 0;
  private spawnCd = 0;
  private spawnRR = 0;

  // Spatial hash over the flow rect: one bucket per tile, intrusive linked list.
  private bucketHead = new Int32Array(0);
  private bucketNext = new Int32Array(256);

  constructor(seed: number) {
    this.rng = new Rng(seed);
    this.terrain = new Terrain(seed);
    this.flow = new FlowField(this.grid, this.terrain);

    // Dry, ore-free ground around the core, plus a guaranteed starter iron patch.
    const a = this.rng.next() * Math.PI * 2;
    this.terrain.forceDisc(0, 0, MAP.coreClearRadius, Ground.Land);
    this.terrain.forceDisc(Math.cos(a) * 6, Math.sin(a) * 6, 2.2, Ground.Ore);
    this.grid.place(this.coreKey, Building.Core);

    this.pickSpawnAngles();
    this.syncFlow();
  }

  get coreHp(): number {
    return this.grid.get(this.coreKey)?.hp ?? 0;
  }

  /** Enemies still to come in the current wave (spawned + queued). */
  get remaining(): number {
    return this.toSpawn + this.enemies.length;
  }

  get nextWaveSize(): number {
    return waveSize(this.wave + 1);
  }

  canAfford(c: Cost): boolean {
    return costEntries(c).every(([r, n]) => this.inv[r] >= n);
  }

  /** Why a building can't go here, or null if it can. */
  placeError(x: number, y: number, b: Placeable): PlaceError | null {
    if (this.phase !== 'build') return 'phase';
    const g = this.terrain.at(x, y);
    if (g === Ground.Water) return 'water';
    if (this.grid.building(key(x, y)) !== Building.None) return 'occupied';
    if (b === Building.Miner && g !== Ground.Ore) return 'no-ore';
    if (!this.inReach(x, y)) return 'reach';
    if (!this.canAfford(BUILDINGS[b].cost)) return 'cost';
    return null;
  }

  /** Within MAP.buildReach (Chebyshev) of any existing building. */
  inReach(x: number, y: number): boolean {
    const r = MAP.buildReach;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (this.grid.tiles.has(key(x + dx, y + dy))) return true;
      }
    }
    return false;
  }

  apply(cmd: Command): boolean {
    const { grid } = this;
    switch (cmd.type) {
      case 'place': {
        if (this.placeError(cmd.x, cmd.y, cmd.building) !== null) return false;
        for (const [r, n] of costEntries(BUILDINGS[cmd.building].cost)) this.inv[r] -= n;
        grid.place(key(cmd.x, cmd.y), cmd.building, cmd.dir ?? 0);
        return true;
      }
      case 'rotate': {
        // Rotating isn't building: allowed mid-wave so you can reroute under pressure.
        if (this.phase === 'lost') return false;
        const t = grid.get(key(cmd.x, cmd.y));
        if (!t || !BUILDINGS[t.b].directed) return false;
        t.dir = (cmd.dir ?? t.dir + 1) & 3;
        return true;
      }
      case 'remove': {
        if (this.phase !== 'build') return false;
        const k = key(cmd.x, cmd.y);
        const t = grid.get(k);
        if (!t || t.b === Building.Core) return false;
        for (const [r, n] of costEntries(BUILDINGS[t.b].cost)) {
          this.inv[r] += Math.floor(n * ECONOMY.refund);
        }
        grid.remove(k);
        return true;
      }
      case 'startWave': {
        if (this.phase !== 'build') return false;
        this.syncFlow(); // spawns final for this wave
        this.wave++;
        this.phase = 'wave';
        this.toSpawn = waveSize(this.wave);
        this.spawnCd = 0;
        this.spawnRR = 0;
        return true;
      }
    }
  }

  tick(): void {
    this.tickCount++;
    for (const e of this.enemies) {
      e.prevX = e.x;
      e.prevY = e.y;
    }
    this.updateShots();
    // Build phase is paused planning: the factory only runs during the wave.
    if (this.phase !== 'wave') return;

    this.syncFlow();
    this.runMiners();
    this.runFurnaces();
    this.runBelts();
    this.spawn();
    this.moveEnemies();
    this.rebuildBuckets();
    this.fireTurrets();
    this.cleanup();

    if (this.coreHp <= 0) {
      this.phase = 'lost';
      return;
    }
    if (this.toSpawn === 0 && this.enemies.length === 0) {
      this.phase = 'build';
      this.pickSpawnAngles();
    }
  }

  // ---------------- Flow field & spawns ----------------

  /**
   * Keep the flow field and spawn points in sync with the base.
   * Build phase: spawns follow the base outward. Wave: spawns are frozen,
   * the field only reacts to buildings being destroyed.
   */
  syncFlow(): void {
    if (this.flowVersion === this.grid.version && this.flowAnglesVersion === this.anglesVersion) return;
    this.flowVersion = this.grid.version;
    this.flowAnglesVersion = this.anglesVersion;

    const candidates = this.phase === 'wave' ? this.spawns : this.spawnCandidates();
    this.flow.compute(this.flowRect(candidates), this.coreKey);
    if (this.phase !== 'wave') this.spawns = candidates.map((k) => this.reachableNear(k));
  }

  private pickSpawnAngles(): void {
    const n = spawnPointCount(this.wave + 1);
    this.spawnAngles = Array.from({ length: n }, () => this.rng.next() * Math.PI * 2);
    this.anglesVersion++;
  }

  private spawnCandidates(): number[] {
    let r = 0;
    for (const k of this.grid.tiles.keys()) r = Math.max(r, Math.hypot(kx(k), ky(k)));
    const d = r + MAP.spawnMargin;
    return this.spawnAngles.map((a) => key(Math.round(Math.cos(a) * d), Math.round(Math.sin(a) * d)));
  }

  private flowRect(spawns: number[]): Rect {
    const b = this.grid.bounds();
    let { x0, y0, x1, y1 } = b;
    for (const k of spawns) {
      x0 = Math.min(x0, kx(k));
      y0 = Math.min(y0, ky(k));
      x1 = Math.max(x1, kx(k));
      y1 = Math.max(y1, ky(k));
    }
    const p = MAP.flowPadding;
    return { x0: x0 - p, y0: y0 - p, x1: x1 + p, y1: y1 + p };
  }

  /** Nearest tile to k (ring search) from which the core is reachable. */
  private reachableNear(k: number): number {
    if (Number.isFinite(this.flow.distAt(k)) && !this.grid.tiles.has(k)) return k;
    const cx = kx(k);
    const cy = ky(k);
    for (let r = 1; r <= 16; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const c = key(cx + dx, cy + dy);
          if (Number.isFinite(this.flow.distAt(c)) && !this.grid.tiles.has(c)) return c;
        }
      }
    }
    return k; // nothing reachable nearby: enemies spawned here get culled
  }

  // ---------------- Factory ----------------

  /** Try to hand one item to tile t (coming from tile `from`). */
  private accept(t: number, from: number, item: Resource): boolean {
    const tile = this.grid.get(t);
    if (!tile) return false;
    switch (tile.b) {
      case Building.Belt:
        // Don't feed a belt head-on (it points back at us).
        if (tile.item !== Item.None || stepKey(t, tile.dir) === from) return false;
        tile.item = item;
        tile.prog = 0;
        return true;
      case Building.Turret: {
        const shots = TURRET.shotsPerItem[item];
        if (tile.ammo + shots > TURRET.maxAmmo) return false;
        tile.ammo += shots;
        return true;
      }
      case Building.Furnace:
        if (item !== Item.Iron || tile.inp >= FURNACE.maxInput || stepKey(t, tile.dir) === from) return false;
        tile.inp++;
        return true;
      case Building.Core:
        this.inv[item]++;
        return true;
      default:
        return false;
    }
  }

  private runMiners(): void {
    for (const [k, t] of this.grid.tiles) {
      if (t.b !== Building.Miner) continue;
      if (t.cd > 0) {
        t.cd--;
        continue;
      }
      // Holds the finished item until the output accepts it.
      if (this.accept(stepKey(k, t.dir), k, Item.Iron)) t.cd = MINER.ticksPerItem;
    }
  }

  private runFurnaces(): void {
    for (const [k, t] of this.grid.tiles) {
      if (t.b !== Building.Furnace) continue;
      if (t.out > 0 && this.accept(stepKey(k, t.dir), k, Item.Plate)) t.out--;
      if (t.cd > 0) {
        t.cd--;
        if (t.cd === 0) t.out++;
      } else if (t.inp > 0 && t.out < FURNACE.maxOutput) {
        t.inp--;
        t.cd = FURNACE.ticksPerPlate;
      }
    }
  }

  private runBelts(): void {
    const end = BELT.ticksPerTile;
    for (const [k, t] of this.grid.tiles) {
      if (t.b !== Building.Belt || t.item === Item.None) continue;
      if (t.prog < end) {
        t.prog++;
        continue;
      }
      if (this.accept(stepKey(k, t.dir), k, t.item as Resource)) {
        t.item = Item.None;
        t.prog = 0;
      }
    }
  }

  // ---------------- Enemies ----------------

  private spawn(): void {
    if (this.toSpawn === 0 || this.spawns.length === 0) return;
    if (this.spawnCd-- > 0) return;
    this.spawnCd = SPAWN_INTERVAL_TICKS;
    this.toSpawn--;

    const k = this.spawns[this.spawnRR++ % this.spawns.length];
    const hp = ENEMY.hp * (1 + ENEMY.hpGrowthPerWave * (this.wave - 1));
    const x = kx(k) + 0.5;
    const y = ky(k) + 0.5;
    this.enemies.push({
      id: this.nextEnemyId++,
      x,
      y,
      prevX: x,
      prevY: y,
      tile: k,
      hp,
      maxHp: hp,
      attackCd: 0,
    });
  }

  private moveEnemies(): void {
    const { grid, flow } = this;
    const step = ENEMY.speed * DT;

    for (const e of this.enemies) {
      const n = flow.nextKey(e.tile);
      if (n === NO_NEXT) {
        // Unreachable (cut off by water / outside the field): cull without reward.
        if (!Number.isFinite(flow.distAt(e.tile))) e.hp = 0;
        continue;
      }

      if (grid.isSolid(n)) {
        // Blocked: chew through whatever is in the way (core included).
        if (e.attackCd > 0) {
          e.attackCd--;
          continue;
        }
        e.attackCd = ENEMY.attackCooldownTicks;
        const t = grid.get(n)!;
        t.hp -= ENEMY.attackDamage;
        if (t.hp <= 0 && t.b !== Building.Core) grid.remove(n);
        continue;
      }

      const tx = kx(n) + 0.5;
      const ty = ky(n) + 0.5;
      const dx = tx - e.x;
      const dy = ty - e.y;
      const d = Math.hypot(dx, dy);
      if (d <= step) {
        e.x = tx;
        e.y = ty;
        e.tile = n;
      } else {
        e.x += (dx / d) * step;
        e.y += (dy / d) * step;
      }
    }
  }

  private rebuildBuckets(): void {
    const { flow } = this;
    const area = flow.w * flow.h;
    if (this.bucketHead.length < area) this.bucketHead = new Int32Array(area);
    this.bucketHead.fill(-1, 0, area);
    if (this.bucketNext.length < this.enemies.length) {
      this.bucketNext = new Int32Array(this.enemies.length * 2);
    }
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      const t = flow.local(key(Math.floor(e.x), Math.floor(e.y)));
      if (t < 0) continue;
      this.bucketNext[i] = this.bucketHead[t];
      this.bucketHead[t] = i;
    }
  }

  private fireTurrets(): void {
    const { flow } = this;
    const r = TURRET.range;
    const r2 = r * r;
    const span = Math.ceil(r);
    const { x0, y0 } = flow.rect;

    for (const [k, t] of this.grid.tiles) {
      if (t.b !== Building.Turret) continue;
      if (t.cd > 0) {
        t.cd--;
        continue;
      }
      if (t.ammo === 0) continue;
      const tx = kx(k);
      const ty = ky(k);
      const cx = tx + 0.5;
      const cy = ty + 0.5;

      // Closest-to-core target in range: classic TD targeting ("first").
      let best = -1;
      let bestDist = Infinity;
      for (let y = Math.max(0, ty - span - y0); y <= Math.min(flow.h - 1, ty + span - y0); y++) {
        for (let x = Math.max(0, tx - span - x0); x <= Math.min(flow.w - 1, tx + span - x0); x++) {
          for (let b = this.bucketHead[y * flow.w + x]; b !== -1; b = this.bucketNext[b]) {
            const e = this.enemies[b];
            if (e.hp <= 0) continue;
            const dx = e.x - cx;
            const dy = e.y - cy;
            if (dx * dx + dy * dy > r2) continue;
            const d = flow.distAt(e.tile);
            if (d < bestDist) {
              bestDist = d;
              best = b;
            }
          }
        }
      }
      if (best === -1) continue;

      const e = this.enemies[best];
      e.hp -= TURRET.damage;
      t.ammo--;
      t.cd = TURRET.cooldownTicks;
      this.shots.push({ fromX: cx, fromY: cy, toX: e.x, toY: e.y, ttl: 6 });
    }
  }

  private cleanup(): void {
    let w = 0;
    for (const e of this.enemies) if (e.hp > 0) this.enemies[w++] = e;
    this.enemies.length = w;
  }

  private updateShots(): void {
    let w = 0;
    for (const s of this.shots) if (--s.ttl > 0) this.shots[w++] = s;
    this.shots.length = w;
  }
}
