// Belts drawn as one continuous line.
//
// Each belt tile gets a shape from its neighbours: straight, or a quarter
// turn when it's fed from one side only (a side feed with a straight feed
// behind stays straight: that's side-loading). The ends of a run get caps:
// a start plate where nothing feeds it, a brass bumper where it leads
// nowhere. No per-tile frame or arrow, and the moving chevrons are continuous
// across tiles, so a run reads as a single conveyor.
//
// Geometry lives in a canonical frame per tile: the belt runs along +u
// (0 = entry edge, 1 = exit edge) and v ∈ [0, 1] goes across it, 0 being the
// left side of travel. pt(u, v) maps that to tile-local ground coords; the
// WebGL shader does the inverse per pixel.

import { BUILDINGS, Building, DIR_X, DIR_Y, isBelt } from './sim/defs';
import { key, kx, ky } from './sim/grid';
import type { World } from './sim/world';

export const Shape = { Straight: 0, TurnLeft: 1, TurnRight: 2 } as const;
export type Shape = (typeof Shape)[keyof typeof Shape];
export const CAP_START = 1;
export const CAP_END = 2;

/** Across-belt layout (v): frame edge, band edge. */
export const RAIL0 = 0.12;
export const BAND0 = 0.2;
export const CAP_W = 0.07;

export interface BeltLook {
  shape: Shape;
  caps: number;
}

let cache: { world: World | null; version: number; map: Map<number, BeltLook> } = { world: null, version: -1, map: new Map() };

const outputsInto = (world: World, fromX: number, fromY: number, toward: number): boolean => {
  const t = world.grid.get(key(fromX, fromY));
  if (!t) return false;
  if (!isBelt(t.b) && t.b !== Building.Miner && t.b !== Building.Furnace) return false;
  return t.dir === toward;
};

/** Shape and caps of every belt, recomputed only when the grid changes. */
export function beltLooks(world: World): Map<number, BeltLook> {
  if (cache.world === world && cache.version === world.grid.version) return cache.map;
  const map = new Map<number, BeltLook>();
  for (const [k, t] of world.grid.tiles) {
    if (!isBelt(t.b)) continue;
    const x = kx(k);
    const y = ky(k);
    const d = t.dir;
    const dl = (d + 3) & 3; // left of travel
    const dr = (d + 1) & 3;
    const back = outputsInto(world, x - DIR_X[d], y - DIR_Y[d], d);
    const left = outputsInto(world, x + DIR_X[dl], y + DIR_Y[dl], (dl + 2) & 3);
    const right = outputsInto(world, x + DIR_X[dr], y + DIR_Y[dr], (dr + 2) & 3);
    const shape: Shape = back ? Shape.Straight : left && !right ? Shape.TurnLeft : right && !left ? Shape.TurnRight : Shape.Straight;
    let caps = 0;
    if (!back && !left && !right) caps |= CAP_START;
    const nx = x + DIR_X[d];
    const ny = y + DIR_Y[d];
    const next = world.grid.get(key(nx, ny));
    // A run ends where the next tile is empty, or a belt facing back at us.
    if (!next || (isBelt(next.b) && next.dir === ((d + 2) & 3)) || (!isBelt(next.b) && !BUILDINGS[next.b].solid)) caps |= CAP_END;
    map.set(k, { shape, caps });
  }
  cache = { world, version: world.grid.version, map };
  return map;
}

/** Canonical (u, v) -> tile-local ground coords (before rotating by dir). */
function canon(shape: number, u: number, v: number): [number, number] {
  if (shape === Shape.Straight) return [u, v];
  const th = Math.PI - (u * Math.PI) / 2;
  if (shape === Shape.TurnLeft) return [1 + v * Math.cos(th), v * Math.sin(th)];
  return [1 + (1 - v) * Math.cos(th), 1 - (1 - v) * Math.sin(th)];
}

/** Rotate canonical (east-running) coords to the belt's facing. */
function orient(dir: number, qx: number, qy: number): [number, number] {
  switch (dir) {
    case 1:
      return [1 - qy, qx];
    case 2:
      return [1 - qx, 1 - qy];
    case 3:
      return [qy, 1 - qx];
    default:
      return [qx, qy];
  }
}

/** Where an item sits along the belt: it waits before the bumper, not past it. */
export function itemU(look: BeltLook | undefined, f: number): number {
  return look && look.caps & CAP_END ? Math.min(f, 0.78) : f;
}

/** World point at (u, v) on the belt at tile (x, y). */
export function beltPoint(x: number, y: number, dir: number, shape: number, u: number, v = 0.5): [number, number] {
  const [qx, qy] = canon(shape, u, v);
  const [fx, fy] = orient(dir, qx, qy);
  return [x + fx, y + fy];
}

/**
 * Canvas 2D: one belt tile in ground coords. Mirrors the WebGL belt shader.
 * `ink` is the outline width in ground units.
 */
export function paintBeltLine(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  fast: boolean,
  dir: number,
  look: BeltLook,
  phase: number,
  ink: number,
  colors: { frame: string; band: string; fastBand: string; slat: string; fastSlat: string; rail: string; ink: string; bumper: string },
): void {
  const n = look.shape === Shape.Straight ? 1 : 10;
  const u0 = look.caps & CAP_START ? CAP_W : 0;
  const u1 = look.caps & CAP_END ? 1 - CAP_W : 1;
  const P = (u: number, v: number) => beltPoint(x, y, dir, look.shape, u, v);
  const strip = (va: number, vb: number, ua = u0, ub = u1) => {
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const [px, py] = P(ua + ((ub - ua) * i) / n, va);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    for (let i = n; i >= 0; i--) {
      const [px, py] = P(ua + ((ub - ua) * i) / n, vb);
      ctx.lineTo(px, py);
    }
    ctx.closePath();
  };
  // Frame (rails) and band
  ctx.fillStyle = fast ? colors.rail : colors.frame;
  strip(RAIL0, 1 - RAIL0);
  ctx.fill();
  ctx.fillStyle = fast ? colors.fastBand : colors.band;
  strip(BAND0, 1 - BAND0);
  ctx.fill();
  // Moving chevrons, clipped to the band
  ctx.save();
  strip(BAND0, 1 - BAND0);
  ctx.clip();
  ctx.strokeStyle = fast ? colors.fastSlat : colors.slat;
  ctx.lineWidth = ink * 1.6;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = -1; i < 4; i++) {
    const u = i / 3 + (phase % (1 / 3));
    const a = P(u - 0.12, 0.24);
    const b = P(u, 0.5);
    const c = P(u - 0.12, 0.76);
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
  }
  ctx.stroke();
  ctx.restore();
  // Outer edges in ink
  ctx.strokeStyle = colors.ink;
  ctx.lineWidth = ink;
  for (const v of [RAIL0, 1 - RAIL0]) {
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const [px, py] = P(u0 + ((u1 - u0) * i) / n, v);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  // Caps: start plate, end bumper
  if (look.caps & CAP_START) {
    const a = P(u0, RAIL0);
    const b = P(u0, 1 - RAIL0);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }
  if (look.caps & CAP_END) {
    ctx.fillStyle = colors.bumper;
    strip(RAIL0, 1 - RAIL0, u1 - 0.07, u1);
    ctx.fill();
    ctx.stroke();
  }
}
