// Simulation core. Pure: no DOM, no rendering, no wall-clock time.
// Everything changes through apply(cmd) or tick(), so a run is reproducible
// from (seed, command log) — useful for replays, debugging and tests.

import { BUILDINGS, Building, ECONOMY, ENEMY, TURRET, waveSize } from './defs';
import { FlowField, NO_NEXT } from './flowfield';
import { Grid } from './grid';
import { Rng } from './rng';

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export type Phase = 'build' | 'wave' | 'lost';

export type Command =
  | { type: 'place'; x: number; y: number; building: Exclude<Building, 0 | 1> }
  | { type: 'remove'; x: number; y: number }
  | { type: 'startWave' };

export interface Enemy {
  id: number;
  x: number; // tile units, centre of tile (tx,ty) is (tx+0.5, ty+0.5)
  y: number;
  prevX: number;
  prevY: number;
  tile: number;
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
  readonly grid: Grid;
  readonly flow: FlowField;
  readonly rng: Rng;

  phase: Phase = 'build';
  wave = 0;
  money = ECONOMY.startMoney;
  tickCount = 0;

  enemies: Enemy[] = [];
  shots: Shot[] = [];

  readonly turretCd: Int32Array;
  readonly coreIdx: number;

  private flowVersion = -1;
  private nextEnemyId = 1;
  private toSpawn = 0;
  private spawnCd = 0;

  // Spatial hash: one bucket per tile, intrusive linked list over enemy indices.
  private bucketHead: Int32Array;
  private bucketNext: Int32Array = new Int32Array(256);

  constructor(w: number, h: number, seed: number) {
    this.grid = new Grid(w, h);
    this.flow = new FlowField(this.grid);
    this.rng = new Rng(seed);
    this.turretCd = new Int32Array(w * h);
    this.bucketHead = new Int32Array(w * h);

    this.coreIdx = this.grid.idx(w - 3, h >> 1);
    this.grid.place(this.coreIdx, Building.Core);
    this.syncFlow();
  }

  get coreHp(): number {
    return this.grid.hp[this.coreIdx];
  }

  /** Enemies still to come in the current wave (spawned + queued). */
  get remaining(): number {
    return this.toSpawn + this.enemies.length;
  }

  get nextWaveSize(): number {
    return waveSize(this.wave + 1);
  }

  canPlace(x: number, y: number): boolean {
    return (
      this.phase === 'build' &&
      this.grid.inBounds(x, y) &&
      x > 0 && // column 0 is the spawn zone
      this.grid.building[this.grid.idx(x, y)] === Building.None
    );
  }

  apply(cmd: Command): boolean {
    switch (cmd.type) {
      case 'place': {
        const def = BUILDINGS[cmd.building];
        if (!this.canPlace(cmd.x, cmd.y) || this.money < def.cost) return false;
        this.money -= def.cost;
        this.grid.place(this.grid.idx(cmd.x, cmd.y), cmd.building);
        return true;
      }
      case 'remove': {
        if (this.phase !== 'build' || !this.grid.inBounds(cmd.x, cmd.y)) return false;
        const i = this.grid.idx(cmd.x, cmd.y);
        const b = this.grid.building[i];
        if (b === Building.None || b === Building.Core) return false;
        this.money += Math.floor(BUILDINGS[b as Exclude<Building, 0>].cost / 2);
        this.grid.remove(i);
        return true;
      }
      case 'startWave': {
        if (this.phase !== 'build') return false;
        this.wave++;
        this.phase = 'wave';
        this.toSpawn = waveSize(this.wave);
        this.spawnCd = 0;
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
    if (this.phase !== 'wave') return;

    this.syncFlow();
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
      this.money += ECONOMY.waveClearBonus;
    }
  }

  /** Rebuild the flow field if the grid changed. Cheap no-op otherwise. */
  syncFlow(): void {
    if (this.flowVersion !== this.grid.version) {
      this.flow.compute();
      this.flowVersion = this.grid.version;
    }
  }

  private spawn(): void {
    if (this.toSpawn === 0) return;
    if (this.spawnCd-- > 0) return;
    this.spawnCd = SPAWN_INTERVAL_TICKS;
    this.toSpawn--;

    const ty = this.rng.int(this.grid.h);
    const hp = ENEMY.hp * (1 + ENEMY.hpGrowthPerWave * (this.wave - 1));
    this.enemies.push({
      id: this.nextEnemyId++,
      x: 0.5,
      y: ty + 0.5,
      prevX: 0.5,
      prevY: ty + 0.5,
      tile: this.grid.idx(0, ty),
      hp,
      maxHp: hp,
      attackCd: 0,
    });
  }

  private moveEnemies(): void {
    const { grid, flow } = this;
    const step = ENEMY.speed * DT;

    for (const e of this.enemies) {
      const n = flow.next[e.tile];
      if (n === NO_NEXT) continue;

      if (grid.building[n] !== Building.None) {
        // Blocked: chew through whatever is in the way (core included).
        if (e.attackCd > 0) {
          e.attackCd--;
          continue;
        }
        e.attackCd = ENEMY.attackCooldownTicks;
        grid.hp[n] -= ENEMY.attackDamage;
        if (grid.hp[n] <= 0 && grid.building[n] !== Building.Core) grid.remove(n);
        continue;
      }

      const tx = (n % grid.w) + 0.5;
      const ty = ((n / grid.w) | 0) + 0.5;
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
    this.bucketHead.fill(-1);
    if (this.bucketNext.length < this.enemies.length) {
      this.bucketNext = new Int32Array(this.enemies.length * 2);
    }
    const w = this.grid.w;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      const t = ((e.y | 0) * w + (e.x | 0)) | 0;
      this.bucketNext[i] = this.bucketHead[t];
      this.bucketHead[t] = i;
    }
  }

  private fireTurrets(): void {
    const { grid } = this;
    const r = TURRET.range;
    const r2 = r * r;
    const span = Math.ceil(r);

    for (let i = 0; i < grid.building.length; i++) {
      if (grid.building[i] !== Building.Turret) continue;
      if (this.turretCd[i] > 0) {
        this.turretCd[i]--;
        continue;
      }
      const tx = i % grid.w;
      const ty = (i / grid.w) | 0;
      const cx = tx + 0.5;
      const cy = ty + 0.5;

      // Closest-to-core target in range: classic TD targeting ("first").
      let best = -1;
      let bestDist = Infinity;
      for (let y = Math.max(0, ty - span); y <= Math.min(grid.h - 1, ty + span); y++) {
        for (let x = Math.max(0, tx - span); x <= Math.min(grid.w - 1, tx + span); x++) {
          for (let k = this.bucketHead[y * grid.w + x]; k !== -1; k = this.bucketNext[k]) {
            const e = this.enemies[k];
            if (e.hp <= 0) continue;
            const dx = e.x - cx;
            const dy = e.y - cy;
            if (dx * dx + dy * dy > r2) continue;
            const d = this.flow.dist[e.tile];
            if (d < bestDist) {
              bestDist = d;
              best = k;
            }
          }
        }
      }
      if (best === -1) continue;

      const e = this.enemies[best];
      e.hp -= TURRET.damage;
      this.turretCd[i] = TURRET.cooldownTicks;
      this.shots.push({ fromX: cx, fromY: cy, toX: e.x, toY: e.y, ttl: 6 });
    }
  }

  private cleanup(): void {
    let w = 0;
    for (let r = 0; r < this.enemies.length; r++) {
      const e = this.enemies[r];
      if (e.hp > 0) {
        this.enemies[w++] = e;
      } else {
        this.money += ENEMY.bounty;
      }
    }
    this.enemies.length = w;
  }

  private updateShots(): void {
    let w = 0;
    for (const s of this.shots) if (--s.ttl > 0) this.shots[w++] = s;
    this.shots.length = w;
  }
}
