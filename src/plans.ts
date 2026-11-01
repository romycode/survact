// Build plans ("ghosts"): what the player intends to build, held in the UI
// until confirmed. The sim never sees them; commit() turns valid plans into
// ordinary commands. Evaluation mirrors commit order (removals, rotations,
// placements) so the colours shown are what will actually happen.

import { BUILDINGS, Building, ECONOMY, costEntries, type Inventory, type Placeable } from './sim/defs';
import { key, kx, ky } from './sim/grid';
import type { Command, World } from './sim/world';

export type Plan =
  | { kind: 'place'; b: Placeable; dir: number }
  | { kind: 'rotate'; dir: number }
  | { kind: 'remove' };

export interface PlanEval {
  ok: Set<number>;
  /** Net resources needed by the valid plans (negative = refund). */
  cost: Inventory;
  okCount: number;
  badCount: number;
}

export class Plans {
  readonly map = new Map<number, Plan>();

  get size(): number {
    return this.map.size;
  }

  get(x: number, y: number): Plan | undefined {
    return this.map.get(key(x, y));
  }

  set(x: number, y: number, p: Plan): void {
    const k = key(x, y);
    this.map.delete(k); // re-insert at the end: order = build order
    this.map.set(k, p);
  }

  delete(x: number, y: number): void {
    this.map.delete(key(x, y));
  }

  clear(): void {
    this.map.clear();
  }

  evaluate(world: World): PlanEval {
    const inv: Inventory = { ...world.inv };
    const start: Inventory = { ...world.inv };
    const ok = new Set<number>();
    const planned = new Set<number>();
    let bad = 0;

    for (const [k, p] of this.map) {
      if (p.kind !== 'remove') continue;
      const t = world.grid.get(k);
      if (!t || t.b === Building.Core || world.phase === 'lost') {
        bad++;
        continue;
      }
      ok.add(k);
      for (const [r, n] of costEntries(BUILDINGS[t.b].cost)) inv[r] += Math.floor(n * ECONOMY.refund);
    }
    for (const [k, p] of this.map) {
      if (p.kind !== 'rotate') continue;
      const t = world.grid.get(k);
      if (t && BUILDINGS[t.b].directed) ok.add(k);
      else bad++;
    }
    for (const [k, p] of this.map) {
      if (p.kind !== 'place') continue;
      const err = world.placeError(kx(k), ky(k), p.b, planned, true);
      const cost = costEntries(BUILDINGS[p.b].cost);
      if (err !== null || !cost.every(([r, n]) => inv[r] >= n)) {
        bad++;
        continue;
      }
      for (const [r, n] of cost) inv[r] -= n;
      planned.add(k);
      ok.add(k);
    }
    const cost = { ...start };
    for (const r of Object.keys(cost)) {
      const id = Number(r) as keyof Inventory;
      cost[id] = start[id] - inv[id];
    }
    return { ok, cost, okCount: ok.size, badCount: bad };
  }

  /** Commands for every valid plan, in the order evaluate() assumed. Clears the plans. */
  commit(world: World): Command[] {
    const { ok } = this.evaluate(world);
    const cmds: Command[] = [];
    for (const kind of ['remove', 'rotate', 'place'] as const) {
      for (const [k, p] of this.map) {
        if (p.kind !== kind || !ok.has(k)) continue;
        const x = kx(k);
        const y = ky(k);
        if (p.kind === 'remove') cmds.push({ type: 'remove', x, y });
        else if (p.kind === 'rotate') cmds.push({ type: 'rotate', x, y, dir: p.dir });
        else cmds.push({ type: 'place', x, y, building: p.b, dir: p.dir });
      }
    }
    this.clear();
    return cmds;
  }
}

/** Axis-aligned L from a to b (long axis first). Inclusive, 4-connected. */
export function lPath(a: [number, number], b: [number, number]): [number, number][] {
  const out: [number, number][] = [];
  let [x, y] = a;
  out.push([x, y]);
  const xFirst = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
  const stepX = () => {
    while (x !== b[0]) {
      x += Math.sign(b[0] - x);
      out.push([x, y]);
    }
  };
  const stepY = () => {
    while (y !== b[1]) {
      y += Math.sign(b[1] - y);
      out.push([x, y]);
    }
  };
  if (xFirst) {
    stepX();
    stepY();
  } else {
    stepY();
    stepX();
  }
  return out;
}

/** Direction from tile a to adjacent tile b. */
export function dirTo(a: [number, number], b: [number, number]): number {
  return b[0] > a[0] ? 0 : b[1] > a[1] ? 1 : b[0] < a[0] ? 2 : 3;
}
