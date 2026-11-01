// Dijkstra from the core over the grid. Every enemy reads its tile's
// "next" pointer: O(1) per enemy per tick, recomputed only on build changes.
//
// Buildings are NOT impassable: they cost extra. Enemies go around when the
// detour is cheaper, and chew through when it's not (or when fully walled).

import { BUILDINGS, Building } from './defs';
import type { Grid } from './grid';

export const NO_NEXT = -1;

export class FlowField {
  readonly dist: Float32Array;
  readonly next: Int32Array;

  private readonly grid: Grid;

  constructor(grid: Grid) {
    this.grid = grid;
    const n = grid.w * grid.h;
    this.dist = new Float32Array(n);
    this.next = new Int32Array(n);
  }

  compute(): void {
    const { grid, dist, next } = this;
    const { w, h } = grid;
    dist.fill(Infinity);
    next.fill(NO_NEXT);

    const heap = new MinHeap();
    for (let i = 0; i < w * h; i++) {
      if (grid.building[i] === Building.Core) {
        dist[i] = 0;
        heap.push(i, 0);
      }
    }

    while (heap.size > 0) {
      const [i, d] = heap.pop();
      if (d > dist[i]) continue;
      const x = i % w;
      const y = (i / w) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        // Cost of stepping from j into i: entering i (where a building may sit).
        const b = grid.building[i];
        const step = 1 + (b === Building.None ? 0 : BUILDINGS[b as Exclude<Building, 0>].pathCost);
        const nd = d + step;
        if (nd < dist[j]) {
          dist[j] = nd;
          next[j] = i;
          heap.push(j, nd);
        }
      }
    }
  }
}

const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(id: number, key: number): void {
    this.ids.push(id);
    this.keys.push(key);
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
    const key = this.keys[0];
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
    return [id, key];
  }
  private swap(a: number, b: number): void {
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}
