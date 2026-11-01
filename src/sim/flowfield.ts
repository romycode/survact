// Dijkstra from the core over a bounded rect (the world is infinite; the
// fight isn't). Every enemy reads its tile's "next" pointer: O(1) per enemy
// per tick, recomputed only when buildings or the rect change.
//
// Water is impassable. Buildings are NOT: they cost extra. Enemies go around when the
// detour is cheaper, and chew through when it's not (or when fully walled).

import { BUILDINGS } from './defs';
import { key, kx, ky, type Grid, type Rect } from './grid';
import type { Terrain } from './terrain';

export const NO_NEXT = -1;

export class FlowField {
  rect: Rect = { x0: 0, y0: 0, x1: -1, y1: -1 };
  w = 0;
  h = 0;
  dist = new Float32Array(0);
  /** Local index of the next tile towards the core, or NO_NEXT. */
  next = new Int32Array(0);

  private cost = new Float32Array(0);
  private readonly grid: Grid;
  private readonly terrain: Terrain;

  constructor(grid: Grid, terrain: Terrain) {
    this.grid = grid;
    this.terrain = terrain;
  }

  /** Local index for a world key, or -1 if outside the rect. */
  local(k: number): number {
    const x = kx(k) - this.rect.x0;
    const y = ky(k) - this.rect.y0;
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? -1 : y * this.w + x;
  }

  toKey(i: number): number {
    return key(this.rect.x0 + (i % this.w), this.rect.y0 + ((i / this.w) | 0));
  }

  /** Next tile key towards the core, or NO_NEXT (outside rect / at core). */
  nextKey(k: number): number {
    const i = this.local(k);
    if (i < 0 || this.next[i] === NO_NEXT) return NO_NEXT;
    return this.toKey(this.next[i]);
  }

  distAt(k: number): number {
    const i = this.local(k);
    return i < 0 ? Infinity : this.dist[i];
  }

  compute(rect: Rect, coreKey: number): void {
    this.rect = rect;
    this.w = rect.x1 - rect.x0 + 1;
    this.h = rect.y1 - rect.y0 + 1;
    const n = this.w * this.h;
    if (this.dist.length < n) {
      this.dist = new Float32Array(n);
      this.next = new Int32Array(n);
      this.cost = new Float32Array(n);
    }
    const { dist, next, cost, w, h } = this;
    dist.fill(Infinity, 0, n);
    next.fill(NO_NEXT, 0, n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        cost[y * w + x] = this.terrain.water(rect.x0 + x, rect.y0 + y) ? -1 : 1;
      }
    }
    for (const [k, t] of this.grid.tiles) {
      const i = this.local(k);
      if (i >= 0) cost[i] = 1 + BUILDINGS[t.b].pathCost;
    }

    const heap = new MinHeap();
    const c = this.local(coreKey);
    if (c < 0) return;
    dist[c] = 0;
    heap.push(c, 0);

    while (heap.size > 0) {
      const [i, d] = heap.pop();
      if (d > dist[i]) continue;
      const x = i % w;
      const y = (i / w) | 0;
      // Cost of stepping from a neighbour into i (where a building may sit).
      const nd = d + cost[i];
      if (x + 1 < w) relax(i + 1);
      if (x > 0) relax(i - 1);
      if (y + 1 < h) relax(i + w);
      if (y > 0) relax(i - w);

      function relax(j: number): void {
        if (cost[j] < 0) return; // water
        if (nd < dist[j]) {
          dist[j] = nd;
          next[j] = i;
          heap.push(j, nd);
        }
      }
    }
  }
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(id: number, k: number): void {
    this.ids.push(id);
    this.keys.push(k);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const id = this.ids[0];
    const k = this.keys[0];
    const lastId = this.ids.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.ids.length > 0) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.ids.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.ids.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return [id, k];
  }
  private swap(a: number, b: number): void {
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}
