// Isometric, read-only view of the world. Never mutates simulation state
// (world.syncFlow() only refreshes a derived cache).
//
// Two passes:
//  1. Ground (affine iso transform, tile units, z = 0): terrain, belts, items,
//     routes, spawn markers, previews.
//  2. Screen space with cam.project(x, y, z): raised things (buildings as
//     extruded prisms, enemies), sorted back-to-front by x + y.

import { Camera, DEPTH, RISE, projAt, type Proj } from './camera';
import { BELT_TICKS, BUILDINGS, Building, DAY, isBelt, DIR_X, DIR_Y, Item, MAP, TURRET, type Placeable } from './sim/defs';
import { NO_NEXT } from './sim/flowfield';
import { T, TerrainCache, paintTerrain } from './terrainLayer';

export const terrainCache = new TerrainCache();
import { key, kx, ky, type Tile } from './sim/grid';
import type { Enemy, World } from './sim/world';
import type { PlanEval, Plans } from './plans';

export type Tool = 'select' | 'wall' | 'turret' | 'belt' | 'fastbelt' | 'miner' | 'furnace' | 'remove';

export const TOOL_BUILDING: Record<Exclude<Tool, 'remove' | 'select'>, Placeable> = {
  wall: Building.Wall,
  turret: Building.Turret,
  belt: Building.Belt,
  fastbelt: Building.FastBelt,
  miner: Building.Miner,
  furnace: Building.Furnace,
};

export const NO_HOVER = -99999;

export interface UiState {
  tool: Tool;
  hoverX: number;
  hoverY: number;
  speed: number;
  /** Facing for new directed buildings, 0=E 1=S 2=W 3=N (world). */
  dir: number;
  /** Selected building (inspector). Girar rotates it if it has a facing. */
  sel: [number, number] | null;
  plans: Plans;
  /** Validity of plans, computed once per frame by main. */
  planEval: PlanEval | null;
}

// Cartoon steampunk palette: brass, copper, riveted iron, oiled wood,
// mossy industrial ground; warm sepia ink outlines everything.
export const C = {
  ink: '#2a1d14',
  bg: '#6f7a3a',
  reachTint: 'rgba(255,236,190,0.18)',
  brass: '#d4a948',
  brassHi: '#f2d488',
  copper: '#c46d3e',
  iron: '#6f6862',
  ironDark: '#4b4540',
  steel: '#9a9ca3',
  wood: '#8a5a36',
  aether: '#6fe0c0',
  aetherHi: '#d4fff1',
  spawn: '#e0402f',
  path: 'rgba(224,64,47,0.55)',
  core: '#6fe0c0',
  wall: '#7a736c',
  turretBase: '#5a534d',
  turret: '#d4a948',
  belt: '#4b4540',
  beltSlat: '#6b625a',
  fastBelt: '#7a4a2c',
  fastBeltRail: '#d4a948',
  fastBeltMark: '#ffe2a0',
  beltMark: '#d4a948',
  miner: '#8a5a36',
  furnace: '#c46d3e',
  furnaceHot: '#ffc35a',
  ore: '#4d4b52',
  oreItem: '#56545c',
  rust: '#b4683e',
  plate: '#cfd2d8',
  noAmmo: '#e0402f',
  enemy: '#c8443c',
  enemyLight: '#f08a6e',
  shadow: 'rgba(40,30,15,0.28)',
  shot: '#ffe3a0',
  sel: '#ffe3a0',
  hpBg: 'rgba(42,29,20,0.8)',
  hpFg: '#8fd45a',
  range: 'rgba(212,169,72,0.85)',
  ok: 'rgba(143,212,90,0.45)',
  bad: 'rgba(224,64,47,0.45)',
  plan: 'rgba(111,224,192,0.35)',
  planEdge: '#3fb38f',
  planBad: 'rgba(224,64,47,0.5)',
};

/** Outline width in CSS px for a given zoom. */
export const inkW = (cam: Proj) => Math.max(1.1, cam.scale * 0.026);

export interface View {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function render(
  ctx: CanvasRenderingContext2D,
  world: World,
  cam: Camera,
  ui: UiState,
  alpha: number,
  dpr: number,
  cssW: number,
  cssH: number,
): void {
  const v = cam.visible();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, cssW, cssH);

  const P = prof.on ? (name: string, t0: number) => (prof.ms[name] = (prof.ms[name] ?? 0) + performance.now() - t0) : null;
  let t = performance.now();
  const cached = terrainCache.draw(ctx, world, cam, dpr, cssW, cssH);
  if (!cached) {
    cam.applyGround(ctx, dpr);
    paintTerrain(ctx, world, v.x0, v.y0, v.x1, v.y1, cam.scale);
  }
  cam.applyGround(ctx, dpr);
  P?.('terrain', t);
  t = performance.now();
  drawGround(ctx, world, cam, ui, v);
  P?.('groundOverlays', t);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  t = performance.now();
  drawShadows(ctx, world, cam, v);
  P?.('shadows', t);
  t = performance.now();
  drawRaised(ctx, world, cam, ui, alpha, v, dpr);
  P?.('raised', t);
  t = performance.now();
  drawLighting(ctx, world, cam, alpha, dpr, cssW, cssH, v);
  P?.('lighting', t);
  t = performance.now();
  drawShotsAndBars(ctx, world, cam, alpha, v);
  P?.('bars', t);
}

/** Opt-in per-phase timings (debug handle: __survact.prof). */
export const prof = { on: false, ms: {} as Record<string, number> };

// =====================================================================
// Ground pass (tile units)
// =====================================================================

function drawGround(ctx: CanvasRenderingContext2D, world: World, cam: Camera, ui: UiState, v: View): void {
  const { grid, terrain } = world;
  const gpx = 2 / cam.scale; // ~1 CSS px in ground units

  // Build reach: only while a build tool is in hand (it's for placing).
  if (world.phase !== 'lost' && ui.tool !== 'select') {
    const reach = reachSet(world);
    ctx.fillStyle = C.reachTint;
    ctx.beginPath();
    for (let y = v.y0; y <= v.y1; y++) {
      for (let x = v.x0; x <= v.x1; x++) {
        if (reach.has(key(x, y)) && !terrain.water(x, y)) ctx.rect(x, y, 1.01, 1.01);
      }
    }
    ctx.fill();
  }

  // Predicted routes + spawn markers
  if (world.phase !== 'lost') drawPaths(ctx, world);
  if (world.phase !== 'lost') {
    const pulse = 0.5 + 0.5 * Math.sin(world.tickCount / 10);
    ctx.strokeStyle = C.spawn;
    ctx.lineWidth = (2 + pulse * 2) * gpx;
    for (const k of world.spawns) {
      ctx.beginPath();
      ctx.arc(kx(k) + 0.5, ky(k) + 0.5, 0.3 + pulse * 0.15, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Belts (flat) and their items
  const gink = 1.6 * gpx;
  for (const [k, t] of grid.tiles) {
    if (!isBelt(t.b) || !inView(k, v)) continue;
    const period = BELT_TICKS[t.b]!;
    paintBelt(ctx, kx(k), ky(k), t.b, t.dir, (world.tickCount % period) / period, gink);
  }
  for (const [k, t] of grid.tiles) {
    if (!isBelt(t.b) || !t.item || !inView(k, v)) continue;
    const s = t.prog / BELT_TICKS[t.b]! - 0.5;
    const cx = kx(k) + 0.5 + DIR_X[t.dir] * s;
    const cy = ky(k) + 0.5 + DIR_Y[t.dir] * s;
    paintItem(ctx, cx, cy, t.item, gink);
  }

  // Plans (ghosts) on the ground
  const ev = ui.planEval;
  for (const [k, p] of ui.plans.map) {
    if (!inView(k, v)) continue;
    const x = kx(k);
    const y = ky(k);
    const ok = ev?.ok.has(k) ?? false;
    if (p.kind === 'remove') {
      ctx.fillStyle = C.planBad;
      ctx.fillRect(x, y, 1, 1);
      ctx.strokeStyle = C.noAmmo;
      ctx.lineWidth = 3 * gpx;
      ctx.beginPath();
      ctx.moveTo(x + 0.25, y + 0.25);
      ctx.lineTo(x + 0.75, y + 0.75);
      ctx.moveTo(x + 0.75, y + 0.25);
      ctx.lineTo(x + 0.25, y + 0.75);
      ctx.stroke();
      continue;
    }
    ctx.fillStyle = ok ? C.plan : C.planBad;
    ctx.fillRect(x, y, 1, 1);
    ctx.strokeStyle = ok ? C.planEdge : C.noAmmo;
    ctx.lineWidth = 1.5 * gpx;
    ctx.strokeRect(x + 0.04, y + 0.04, 0.92, 0.92);
    if (p.kind === 'rotate' || BUILDINGS[p.b].directed) groundArrow(ctx, x + 0.5, y + 0.5, p.dir, 0.3, C.shot);
  }

  // Selection + placement preview (on the ground, under buildings)
  if (ui.sel && grid.get(key(ui.sel[0], ui.sel[1]))) {
    ctx.strokeStyle = C.sel;
    ctx.lineWidth = 2.5 * gpx;
    ctx.strokeRect(ui.sel[0] + 0.03, ui.sel[1] + 0.03, 0.94, 0.94);
  }
  if (world.phase !== 'lost' && ui.hoverX !== NO_HOVER && ui.tool !== 'select') {
    const hx = ui.hoverX;
    const hy = ui.hoverY;
    const b = grid.building(key(hx, hy));
    const ok =
      ui.tool === 'remove'
        ? b !== Building.None && b !== Building.Core
        : world.placeError(hx, hy, TOOL_BUILDING[ui.tool]) === null || isDirected(world, hx, hy);
    ctx.fillStyle = ok ? C.ok : C.bad;
    ctx.fillRect(hx, hy, 1, 1);
    if (ui.tool === 'belt' || ui.tool === 'fastbelt' || ui.tool === 'miner' || ui.tool === 'furnace') {
      groundArrow(ctx, hx + 0.5, hy + 0.5, ui.dir, 0.3, C.shot);
    }
    if (ui.tool === 'turret') {
      ctx.strokeStyle = C.range;
      ctx.lineWidth = 1.5 * gpx;
      ctx.beginPath();
      ctx.arc(hx + 0.5, hy + 0.5, TURRET.range, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/** Tiles on the predicted enemy routes (spawns → core). Shared by both renderers. */
export function routeKeys(world: World): Set<number> {
  world.syncFlow();
  const seen = new Set<number>();
  for (const s of world.spawns) {
    let k = s;
    for (let guard = 0; k !== NO_NEXT && guard < 5000; guard++) {
      if (seen.has(k)) break;
      seen.add(k);
      k = world.flow.nextKey(k);
    }
  }
  return seen;
}

function drawPaths(ctx: CanvasRenderingContext2D, world: World): void {
  const seen = routeKeys(world);
  ctx.fillStyle = C.path;
  ctx.beginPath();
  for (const k of seen) {
    if (k === world.coreKey) continue;
    const x = kx(k) + 0.5;
    const y = ky(k) + 0.5;
    ctx.moveTo(x + 0.1, y);
    ctx.arc(x, y, 0.1, 0, Math.PI * 2);
  }
  ctx.fill();
}

export function groundArrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, d: number, size: number, color: string): void {
  const pts = arrowPoints(cx, cy, d, size);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();
}

/**
 * A belt tile in ground coords: iron frame, rubber band with slats that move,
 * brass chevrons. Fast belts: copper band with brass side rails.
 */
export function paintBelt(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  b: number,
  dir: number,
  phase: number,
  ink: number,
): void {
  const fast = b === Building.FastBelt;
  const along = DIR_X[dir] !== 0; // band runs along x
  ctx.fillStyle = C.ironDark;
  ctx.fillRect(x + 0.06, y + 0.06, 0.88, 0.88);
  ctx.fillStyle = fast ? C.fastBelt : C.belt;
  if (along) ctx.fillRect(x + 0.06, y + 0.2, 0.88, 0.6);
  else ctx.fillRect(x + 0.2, y + 0.06, 0.6, 0.88);
  // slats moving with the band
  ctx.strokeStyle = fast ? '#9a6038' : C.beltSlat;
  ctx.lineWidth = ink * 1.2;
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const s = ((i / 3 + phase) % 1) * 0.88 + 0.06;
    const t = DIR_X[dir] < 0 || DIR_Y[dir] < 0 ? 1 - s : s;
    if (along) {
      ctx.moveTo(x + t, y + 0.22);
      ctx.lineTo(x + t, y + 0.78);
    } else {
      ctx.moveTo(x + 0.22, y + t);
      ctx.lineTo(x + 0.78, y + t);
    }
  }
  ctx.stroke();
  if (fast) {
    ctx.fillStyle = C.fastBeltRail;
    if (along) {
      ctx.fillRect(x + 0.06, y + 0.12, 0.88, 0.07);
      ctx.fillRect(x + 0.06, y + 0.81, 0.88, 0.07);
    } else {
      ctx.fillRect(x + 0.12, y + 0.06, 0.07, 0.88);
      ctx.fillRect(x + 0.81, y + 0.06, 0.07, 0.88);
    }
  }
  groundArrow(ctx, x + 0.5 + DIR_X[dir] * 0.12, y + 0.5 + DIR_Y[dir] * 0.12, dir, 0.16, fast ? C.fastBeltMark : C.beltMark);
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = ink;
  ctx.strokeRect(x + 0.06, y + 0.06, 0.88, 0.88);
}

/** Iron ore chunk (rough, rusty) or a steel plate, in ground coords. */
export function paintItem(ctx: CanvasRenderingContext2D, cx: number, cy: number, item: number, ink: number): void {
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = ink;
  ctx.beginPath();
  if (item === Item.Plate) {
    ctx.fillStyle = C.plate;
    ctx.rect(cx - 0.16, cy - 0.16, 0.32, 0.32);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = C.ink;
    for (const [dx, dy] of [[-0.09, -0.09], [0.09, -0.09], [-0.09, 0.09], [0.09, 0.09]]) {
      ctx.beginPath();
      ctx.arc(cx + dx, cy + dy, 0.025, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    ctx.fillStyle = C.oreItem;
    ctx.moveTo(cx - 0.16, cy - 0.02);
    ctx.lineTo(cx - 0.05, cy - 0.16);
    ctx.lineTo(cx + 0.14, cy - 0.1);
    ctx.lineTo(cx + 0.16, cy + 0.08);
    ctx.lineTo(cx + 0.02, cy + 0.16);
    ctx.lineTo(cx - 0.12, cy + 0.12);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = C.rust;
    ctx.beginPath();
    ctx.arc(cx + 0.04, cy - 0.04, 0.05, 0, Math.PI * 2);
    ctx.fill();
  }
}

function arrowPoints(cx: number, cy: number, d: number, size: number): [number, number][] {
  const fx = DIR_X[d];
  const fy = DIR_Y[d];
  const px = -fy;
  const py = fx;
  return [
    [cx + fx * size, cy + fy * size],
    [cx - fx * size * 0.6 + px * size * 0.8, cy - fy * size * 0.6 + py * size * 0.8],
    [cx - fx * size * 0.2, cy - fy * size * 0.2],
    [cx - fx * size * 0.6 - px * size * 0.8, cy - fy * size * 0.6 - py * size * 0.8],
  ];
}

// =====================================================================
// Screen pass (projected)
// =====================================================================

type Drawable = { depth: number; draw: () => void };

// ---------------- building sprites ----------------
// Buildings are drawn once per (type, facing, state, zoom) into a bitmap and
// blitted, instead of re-tracing 5–15 outlined polygons each per frame.
// Only the core (animated gem) and furnace smoke are drawn live.

export const AIM_STEPS = 16;
export const SPRITE_TOP = 1.7; // tallest silhouette, in tile heights
const SPRITE_SETTLE = 6;

interface Sprite {
  img: CanvasImageSource;
  w: number;
  h: number;
  /** Device px of the tile's top-left ground corner inside the sprite. */
  ax: number;
  ay: number;
}

const sprites = {
  map: new Map<string, Sprite>(),
  scale: 0,
  last: 0,
  still: 0,
  /** Track zoom; switch sprite resolution once the zoom has settled. */
  tick(dev: number): void {
    this.still = dev === this.last ? this.still + 1 : 0;
    this.last = dev;
    if (this.scale === 0 || (this.still >= SPRITE_SETTLE && dev !== this.scale)) {
      for (const sp of this.map.values()) if ('close' in sp.img) (sp.img as ImageBitmap).close();
      this.map.clear();
      this.scale = dev;
    }
  },
  get(t: Tile, aim: number | undefined, variant: string): Sprite {
    const S = this.scale;
    const id = `${t.b}|${t.dir}|${variant}`;
    let sp = this.map.get(id);
    if (sp) return sp;
    const pad = Math.ceil(S * 0.2);
    const w = Math.ceil(S + 2 * pad);
    const h = Math.ceil(S * DEPTH + SPRITE_TOP * S * RISE + 2 * pad);
    const ax = pad;
    const ay = pad + SPRITE_TOP * S * RISE;
    const canvas: HTMLCanvasElement | OffscreenCanvas =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const g = canvas.getContext('2d') as CanvasRenderingContext2D;
    // (0,0,0) — the tile's top-left ground corner — lands on (ax, ay), device px.
    drawBuilding(g, projAt(S, ax, ay), 0, 0, t, 0, aim, false);
    const img: CanvasImageSource = canvas instanceof HTMLCanvasElement ? canvas : canvas.transferToImageBitmap();
    sp = { img, w, h, ax, ay };
    this.map.set(id, sp);
    return sp;
  },
};

function blitBuilding(ctx: CanvasRenderingContext2D, cam: Camera, x: number, y: number, t: Tile, time: number): void {
  const aimAngle = turretAim.get(key(x, y)) ?? Math.PI / 2;
  if (t.b === Building.Core) {
    drawBuilding(ctx, cam, x, y, t, time, aimAngle);
    return;
  }
  let aim: number | undefined;
  let variant = '';
  if (t.b === Building.Turret) {
    const q = aimStep(x, y);
    aim = (q / AIM_STEPS) * Math.PI * 2;
    variant = `${q}${t.ammo === 0 ? 'e' : ''}`;
  } else if (t.b === Building.Furnace || t.b === Building.Miner) {
    variant = t.cd > 0 ? 'on' : 'off';
  }
  const sp = sprites.get(t, aim, variant);
  const k = cam.scale / sprites.scale; // sprite device px -> CSS px
  const [tx, ty] = cam.project(x, y, 0);
  ctx.drawImage(sp.img, tx - sp.ax * k, ty - sp.ay * k, sp.w * k, sp.h * k);
  // Live effects on top of the baked body.
  if (t.b === Building.Furnace && t.cd > 0) smoke(ctx, cam, x, y, time);
}

function drawRaised(ctx: CanvasRenderingContext2D, world: World, cam: Camera, ui: UiState, alpha: number, v: View, dpr: number): void {
  updateAims(world);
  sprites.tick(cam.scale * dpr);
  const list: Drawable[] = [];
  for (const [k, t] of world.grid.tiles) {
    if (isBelt(t.b) || !inView(k, v)) continue;
    const x = kx(k);
    const y = ky(k);
    // Back to front = north to south (then west to east).
    list.push({ depth: y + 1 + x * 1e-4, draw: () => blitBuilding(ctx, cam, x, y, t, world.tickCount) });
  }
  for (const e of world.enemies) {
    const ex = lerp(e.prevX, e.x, alpha);
    const ey = lerp(e.prevY, e.y, alpha);
    list.push({ depth: ey + 0.5 + ex * 1e-4, draw: () => drawEnemy(ctx, cam, ex, ey, e) });
  }
  for (const [k, p] of ui.plans.map) {
    if (p.kind !== 'place' || isBelt(p.b) || !inView(k, v)) continue;
    const x = kx(k);
    const y = ky(k);
    const ghost: Tile = { b: p.b, hp: 1, dir: p.dir, cd: 0, ammo: 1, inp: 0, out: 0, item: 0, prog: 0 };
    const ok = ui.planEval?.ok.has(k) ?? false;
    list.push({
      depth: y + 1 + x * 1e-4,
      draw: () => {
        ctx.globalAlpha = ok ? 0.45 : 0.25;
        blitBuilding(ctx, cam, x, y, ghost, 0);
        ctx.globalAlpha = 1;
      },
    });
  }
  list.sort((a, b) => a.depth - b.depth);
  for (const d of list) d.draw();
}

/** Top of each building's silhouette (shadows, bars, icon framing). */
export const HEIGHT: Partial<Record<Building, number>> = {
  [Building.Core]: 1.65,
  [Building.Wall]: 0.62,
  [Building.Miner]: 1.15,
  [Building.Furnace]: 1.3,
  [Building.Turret]: 0.62,
}

/** Last aim angle per turret (render-side only, from the shots it fired). */
export const turretAim = new Map<number, number>();

/** Turrets keep facing their last shot. */
export function updateAims(world: World): void {
  for (const sh of world.shots) {
    turretAim.set(key(Math.floor(sh.fromX), Math.floor(sh.fromY)), Math.atan2(sh.toY - sh.fromY, sh.toX - sh.fromX));
  }
}

/** Turret aim quantised to the baked sprite steps. */
export function aimStep(x: number, y: number): number {
  const a = turretAim.get(key(x, y)) ?? Math.PI / 2;
  return ((Math.round((a / (Math.PI * 2)) * AIM_STEPS) % AIM_STEPS) + AIM_STEPS) % AIM_STEPS;
}

export function drawBuilding(
  ctx: CanvasRenderingContext2D,
  cam: Proj,
  x: number,
  y: number,
  t: Tile,
  time = 0,
  aimOverride?: number,
  fx = true,
): void {
  const cx = x + 0.5;
  const cy = y + 0.5;
  switch (t.b) {
    case Building.Core: {
      // Steam engine: riveted iron plinth, copper boiler with brass bands,
      // brass dome, and an aether crystal floating in a cage of steam.
      prism(ctx, cam, x + 0.04, y + 0.04, x + 0.96, y + 0.96, 0, 0.16, C.ironDark);
      rivets(ctx, cam, x + 0.04, y + 0.04, x + 0.96, y + 0.96, 0.1, 5);
      cylinder(ctx, cam, cx, cy, 0.16, 0.72, 0.34, C.copper);
      cylinder(ctx, cam, cx, cy, 0.3, 0.36, 0.35, C.brass);
      cylinder(ctx, cam, cx, cy, 0.58, 0.64, 0.35, C.brass);
      dome(ctx, cam, cx, cy, 0.72, 0.3, C.brass);
      // Pressure gauge on the front
      gauge(ctx, cam, cx + 0.24, cy + 0.24, 0.46, time);
      const bob = 0.05 * Math.sin(time / 28);
      const w = 0.24;
      const zb = 0.98 + bob;
      const zm = 1.3 + bob;
      const zt = 1.65 + bob;
      const L: P3 = [cx - w, cy, zm];
      const R: P3 = [cx + w, cy, zm];
      const F: P3 = [cx, cy + w, zm];
      tri(ctx, cam, L, F, [cx, cy, zb], shade(C.aether, 0.55));
      tri(ctx, cam, F, R, [cx, cy, zb], shade(C.aether, 0.72));
      tri(ctx, cam, L, F, [cx, cy, zt], shade(C.aether, 0.9));
      tri(ctx, cam, F, R, [cx, cy, zt], C.aetherHi);
      break;
    }
    case Building.Wall: {
      // Riveted iron bulwark with a brass cap rail.
      prism(ctx, cam, x + 0.03, y + 0.03, x + 0.97, y + 0.97, 0, 0.5, C.wall);
      seams(ctx, cam, x + 0.03, y + 0.03, x + 0.97, y + 0.97, 0.25);
      rivets(ctx, cam, x + 0.03, y + 0.03, x + 0.97, y + 0.97, 0.42, 4);
      prism(ctx, cam, x + 0.0, y + 0.0, x + 1.0, y + 1.0, 0.5, 0.56, C.brass);
      prism(ctx, cam, x + 0.14, y + 0.14, x + 0.86, y + 0.86, 0.56, 0.62, C.ironDark);
      break;
    }
    case Building.Miner: {
      // Wooden platform, iron derrick with cross-bracing, brass gear wheel on top.
      prism(ctx, cam, x + 0.06, y + 0.06, x + 0.94, y + 0.94, 0, 0.18, C.wood);
      planks(ctx, cam, x + 0.06, y + 0.06, x + 0.94, y + 0.94, 0.18);
      const front = t.dir === 1;
      if (!front) chute(ctx, cam, cx, cy, t.dir);
      const zTop = 0.95;
      derrick(ctx, cam, x + 0.2, y + 0.2, x + 0.8, y + 0.8, 0.18, [cx, cy, zTop]);
      const [px, py] = cam.project(cx, cy, zTop);
      gear(ctx, px, py, cam.scale * 0.15, 10, C.brass, t.cd > 0 ? (time / 6) % (Math.PI * 2) : 0, inkW(cam));
      if (front) chute(ctx, cam, cx, cy, t.dir);
      break;
    }
    case Building.Furnace: {
      // Copper boiler-furnace with riveted bands, iron smokestack with a brass
      // collar at the back, glowing firebox on the output side.
      prism(ctx, cam, x + 0.08, y + 0.08, x + 0.92, y + 0.92, 0, 0.55, C.furnace);
      bands(ctx, cam, x + 0.08, y + 0.08, x + 0.92, y + 0.92, [0.12, 0.43]);
      rivets(ctx, cam, x + 0.08, y + 0.08, x + 0.92, y + 0.92, 0.27, 4);
      cylinder(ctx, cam, x + 0.27, y + 0.27, 0.55, 1.22, 0.12, C.ironDark);
      cylinder(ctx, cam, x + 0.27, y + 0.27, 1.12, 1.24, 0.15, C.brass);
      furnaceMouth(ctx, cam, x, y, t, t.cd > 0 ? C.furnaceHot : '#2a1006');
      raisedArrow(ctx, cam, cx + 0.14, cy + 0.14, 0.55, t.dir, 0.15, C.ink);
      if (fx && t.cd > 0) smoke(ctx, cam, x, y, time);
      break;
    }
    case Building.Turret: {
      // Riveted iron drum base, brass dome head, copper barrel with brass muzzle ring.
      cylinder(ctx, cam, cx, cy, 0, 0.24, 0.4, C.turretBase);
      const aim = aimOverride ?? turretAim.get(key(x, y)) ?? Math.PI / 4;
      const empty = t.ammo === 0;
      const head = empty ? '#a08a5a' : C.turret;
      const bx = cx + Math.cos(aim) * 0.52;
      const by = cy + Math.sin(aim) * 0.52;
      const barrelFront = Math.sin(aim) > 0;
      const barrel = () => {
        const [ax, ay] = cam.project(cx, cy, 0.4);
        const [ex, ey] = cam.project(bx, by, 0.42);
        ctx.lineCap = 'round';
        const bw = Math.max(2, cam.scale * 0.09);
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = bw + inkW(cam) * 2;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        ctx.strokeStyle = C.copper;
        ctx.lineWidth = bw;
        ctx.stroke();
        // muzzle ring
        ctx.fillStyle = C.brass;
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = inkW(cam);
        ctx.beginPath();
        ctx.arc(ex, ey, bw * 0.75, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.lineCap = 'butt';
      };
      if (!barrelFront) barrel();
      cylinder(ctx, cam, cx, cy, 0.24, 0.36, 0.27, head);
      dome(ctx, cam, cx, cy, 0.36, 0.24, head);
      if (barrelFront) barrel();
      if (empty) {
        const [sx, sy] = cam.project(cx, cy, 0.5);
        ctx.strokeStyle = C.noAmmo;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(sx, sy, 0.26 * cam.scale, 0.26 * cam.scale * DEPTH, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
  }
}

// ---------------- steampunk detail helpers ----------------

/** Furnace smoke: three puffs rising and drifting from the stack. */
/** Smoke puff i (0..2): ground x, y, height z, radius (tiles), alpha. */
export function smokePuff(x: number, y: number, time: number, i: number): [number, number, number, number, number] {
  const ph = (time / 50 + i / 3) % 1;
  return [x + 0.27 - ph * 0.12, y + 0.27, 1.3 + ph * 0.8, 0.05 + 0.08 * ph, 0.5 * (1 - ph)];
}

function smoke(ctx: CanvasRenderingContext2D, cam: Proj, x: number, y: number, time: number): void {
  for (let i = 0; i < 3; i++) {
    const [px, py, pz, r, a] = smokePuff(x, y, time, i);
    const [sx, sy] = cam.project(px, py, pz);
    ctx.fillStyle = `rgba(200,190,175,${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(sx, sy, cam.scale * r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Brass rivets along the front face of a box, at height z. */
function rivets(ctx: CanvasRenderingContext2D, cam: Proj, x0: number, _y0: number, x1: number, y1: number, z: number, n: number): void {
  const r = Math.max(1, cam.scale * 0.022);
  ctx.fillStyle = C.brassHi;
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = Math.max(0.6, r * 0.5);
  for (let i = 0; i < n; i++) {
    const f = (i + 0.5) / n;
    const [px, py] = cam.project(x0 + (x1 - x0) * f, y1, z);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

/** Vertical plate seams on the visible faces. */
function seams(ctx: CanvasRenderingContext2D, cam: Proj, x0: number, y0: number, x1: number, y1: number, z: number): void {
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = Math.max(0.8, inkW(cam) * 0.6);
  ctx.beginPath();
  for (const f of [1 / 3, 2 / 3]) {
    const mx = x0 + (x1 - x0) * f;
    const [ax, ay] = cam.project(mx, y1, 0);
    const [bx, by] = cam.project(mx, y1, z * 2);
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
  }
  void y0;
  ctx.stroke();
}

/** Horizontal metal bands around a box at the given heights. */
function bands(ctx: CanvasRenderingContext2D, cam: Proj, x0: number, y0: number, x1: number, y1: number, zs: number[]): void {
  for (const z of zs) {
    quad(ctx, cam, [[x0, y1, z], [x1, y1, z], [x1, y1, z + 0.05], [x0, y1, z + 0.05]], C.brass);
    void y0;
  }
}

/** Plank lines on top of a wooden platform. */
function planks(ctx: CanvasRenderingContext2D, cam: Proj, x0: number, y0: number, x1: number, y1: number, z: number): void {
  ctx.strokeStyle = 'rgba(42,29,20,0.45)';
  ctx.lineWidth = Math.max(0.8, inkW(cam) * 0.6);
  ctx.beginPath();
  for (let i = 1; i < 4; i++) {
    const f = x0 + ((x1 - x0) * i) / 4;
    const [ax, ay] = cam.project(f, y0, z);
    const [bx, by] = cam.project(f, y1, z);
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
  }
  ctx.stroke();
}

/** Iron lattice tower: pyramid faces with X bracing. */
function derrick(ctx: CanvasRenderingContext2D, cam: Proj, x0: number, y0: number, x1: number, y1: number, z0: number, apex: P3): void {
  pyramid(ctx, cam, x0, y0, x1, y1, z0, apex, C.iron);
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = Math.max(0.8, inkW(cam) * 0.7);
  ctx.beginPath();
  const zm = z0 + (apex[2] - z0) * 0.45;
  const ins = 0.45 * 0.5;
  const pts: [P3, P3][] = [
    [[x0, y1, z0], [x1 - (x1 - x0) * ins, y1 - (y1 - y0) * ins, zm]],
    [[x1, y1, z0], [x0 + (x1 - x0) * ins, y1 - (y1 - y0) * ins, zm]],
  ];
  for (const [a, b] of pts) {
    const [ax, ay] = cam.project(a[0], a[1], a[2]);
    const [bx, by] = cam.project(b[0], b[1], b[2]);
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
  }
  ctx.stroke();
}

/** Upright gear facing the viewer (screen space). */
function gear(ctx: CanvasRenderingContext2D, px: number, py: number, r: number, teeth: number, color: string, phase: number, ink: number): void {
  ctx.fillStyle = color;
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = ink;
  ctx.beginPath();
  const n = teeth * 2;
  for (let i = 0; i < n; i++) {
    const a0 = phase + (i / n) * Math.PI * 2;
    const a1 = phase + ((i + 1) / n) * Math.PI * 2;
    const rr = i % 2 ? r * 0.78 : r;
    ctx.lineTo(px + Math.cos(a0) * rr, py + Math.sin(a0) * rr);
    ctx.lineTo(px + Math.cos(a1) * rr, py + Math.sin(a1) * rr);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = C.ink;
  ctx.beginPath();
  ctx.arc(px, py, r * 0.25, 0, Math.PI * 2);
  ctx.fill();
}

/** Half-dome cap on a cylinder top (screen-space ellipse arc). */
function dome(ctx: CanvasRenderingContext2D, cam: Proj, cx: number, cy: number, z: number, r: number, color: string): void {
  const [sx, sy] = cam.project(cx, cy, z);
  const rx = r * cam.scale;
  const ry = r * cam.scale * DEPTH;
  const h = r * cam.scale * RISE * 0.8;
  ctx.fillStyle = color;
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = inkW(cam);
  ctx.beginPath();
  ctx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI);
  ctx.bezierCurveTo(sx - rx, sy - h * 1.2, sx + rx, sy - h * 1.2, sx + rx, sy);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.beginPath();
  ctx.ellipse(sx - rx * 0.35, sy - h * 0.45, rx * 0.22, h * 0.18, -0.4, 0, Math.PI * 2);
  ctx.fill();
}

/** Small pressure gauge (face + needle) at a point on a surface. */
function gauge(ctx: CanvasRenderingContext2D, cam: Proj, x: number, y: number, z: number, time: number): void {
  const [px, py] = cam.project(x, y, z);
  const r = cam.scale * 0.08;
  ctx.fillStyle = '#f3e3c0';
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = inkW(cam);
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  const a = -Math.PI * 0.75 + 0.4 * Math.sin(time / 40);
  ctx.lineWidth = Math.max(0.8, r * 0.18);
  ctx.strokeStyle = '#b3261e';
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px + Math.cos(a) * r * 0.75, py + Math.sin(a) * r * 0.75);
  ctx.stroke();
}

/** Glowing furnace mouth on the face it outputs through (or the top edge if that face is hidden). */
/**
 * Furnace mouth in ground coords: [x0, x1, y, z0, z1] on the front face, or
 * for north-facing ones [x0, x1, y0, y1, z] lying on the top (top: true).
 */
export function mouthRect(x: number, y: number, dir: number): { top: boolean; a: number; b: number; c: number; d: number; e: number } {
  const cx = x + 0.5;
  if (dir === 3) return { top: true, a: cx - 0.17, b: cx + 0.17, c: y + 0.1, d: y + 0.3, e: 0.55 };
  const mx = dir === 0 ? x + 0.72 : dir === 2 ? x + 0.28 : cx;
  const w = dir === 1 ? 0.17 : 0.12;
  return { top: false, a: mx - w, b: mx + w, c: y + 0.92, d: 0.1, e: 0.34 };
}

export function furnaceMouth(ctx: CanvasRenderingContext2D, cam: Proj, x: number, y: number, t: Tile, color: string): void {
  const cx = x + 0.5;
  const z0 = 0.1;
  const z1 = 0.34;
  if (t.dir === 3) {
    quad(ctx, cam, [[cx - 0.17, y + 0.1, 0.55], [cx + 0.17, y + 0.1, 0.55], [cx + 0.17, y + 0.3, 0.55], [cx - 0.17, y + 0.3, 0.55]], color, false);
    return;
  }
  // East/west outputs sit at that end of the front face; south is centred.
  const mx = t.dir === 0 ? x + 0.72 : t.dir === 2 ? x + 0.28 : cx;
  const w = t.dir === 1 ? 0.17 : 0.12;
  quad(ctx, cam, [[mx - w, y + 0.92, z0], [mx + w, y + 0.92, z0], [mx + w, y + 0.92, z1], [mx - w, y + 0.92, z1]], color, false);
}

/** Miner's output chute: a short box from the centre towards the output side. */
function chute(ctx: CanvasRenderingContext2D, cam: Proj, cx: number, cy: number, d: number): void {
  const fx = DIR_X[d];
  const fy = DIR_Y[d];
  const w = 0.11;
  const ax = cx + fx * 0.2;
  const ay = cy + fy * 0.2;
  const bx = cx + fx * 0.5;
  const by = cy + fy * 0.5;
  prism(ctx, cam, Math.min(ax, bx) - (fx ? 0 : w), Math.min(ay, by) - (fy ? 0 : w), Math.max(ax, bx) + (fx ? 0 : w), Math.max(ay, by) + (fy ? 0 : w), 0.12, 0.3, C.copper);
}

/** Animation state of an enemy at a position (pure: same input, same pose). */
export function enemyPose(cam: Camera, x: number, y: number, e: Enemy): { hop: number; spin: number; look: number } {
  const hop = Math.abs(Math.sin((x + y) * 4 + e.id));
  const spin = Math.cos((x + y) * 3 + e.id);
  const [gx, gy] = cam.project(x, y, 0);
  const [hx, hy] = cam.project(x + (e.x - e.prevX) * 30, y + (e.y - e.prevY) * 30, 0);
  return { hop, spin, look: Math.atan2(hy - gy, hx - gx) };
}

/**
 * Wind-up mite body (no shadow), with its ground point at (gx, gy) in screen
 * px and `s` px per tile. Shared by the 2D renderer and the WebGL atlas.
 */
export function paintMite(
  ctx: CanvasRenderingContext2D,
  gx: number,
  gy: number,
  s: number,
  hop: number,
  spin: number,
  look: number,
  ink: number,
): void {
  // Hop: squash at the bottom, stretch in the air.
  const sq = 1 + (1 - hop) * 0.18;
  const bx = gx;
  const by = gy - (0.16 + hop * 0.14) * s * RISE;
  const rx = s * 0.17 * sq;
  const ry = (s * 0.15) / sq;
  ctx.fillStyle = C.enemy;
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = ink;
  ctx.beginPath();
  ctx.ellipse(bx, by, rx, ry, 0, Math.PI, 0);
  ctx.quadraticCurveTo(bx + rx, by + ry * 0.8, bx, by + ry * 0.8);
  ctx.quadraticCurveTo(bx - rx, by + ry * 0.8, bx - rx, by);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = C.enemyLight;
  ctx.beginPath();
  ctx.ellipse(bx - rx * 0.4, by - ry * 0.45, rx * 0.22, ry * 0.18, -0.5, 0, Math.PI * 2);
  ctx.fill();
  // Clockwork: a brass wind-up key on its back that spins as it hops.
  const kx0 = bx + rx * 0.15;
  const ky0 = by - ry * 0.85;
  const kh = s * 0.11;
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = Math.max(2, s * 0.03) + ink * 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(kx0, ky0);
  ctx.lineTo(kx0, ky0 - kh);
  ctx.stroke();
  ctx.strokeStyle = C.brass;
  ctx.lineWidth = Math.max(2, s * 0.03);
  ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.fillStyle = C.brass;
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = ink;
  const lw = s * 0.07 * Math.max(0.25, Math.abs(spin));
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(kx0 + side * lw, ky0 - kh, lw, s * 0.045, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  // Eyes looking where it's heading (screen space)
  const er = Math.max(1.6, s * 0.045);
  for (const side of [-1, 1]) {
    const ex = bx + side * rx * 0.38;
    const ey = by - ry * 0.05;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(ex, ey, er, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = C.ink;
    ctx.beginPath();
    ctx.arc(ex + Math.cos(look) * er * 0.4, ey + Math.sin(look) * er * 0.4, er * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawEnemy(ctx: CanvasRenderingContext2D, cam: Camera, x: number, y: number, e: Enemy): void {
  const s = cam.scale;
  const [gx, gy] = cam.project(x, y, 0);
  ctx.fillStyle = C.shadow;
  ctx.beginPath();
  ctx.ellipse(gx, gy, s * 0.17, s * 0.085, 0, 0, Math.PI * 2);
  ctx.fill();
  const p = enemyPose(cam, x, y, e);
  paintMite(ctx, gx, gy, s, p.hop, p.spin, p.look, inkW(cam));
}

function drawShotsAndBars(ctx: CanvasRenderingContext2D, world: World, cam: Camera, alpha: number, v: View): void {
  ctx.strokeStyle = C.shot;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const s of world.shots) {
    const [ax, ay] = cam.project(s.fromX, s.fromY, 0.6);
    const [bx, by] = cam.project(s.toX, s.toY, 0.32);
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
  }
  ctx.stroke();

  const w = cam.scale * 0.45;
  for (const [k, t] of world.grid.tiles) {
    if (!inView(k, v)) continue;
    const max = BUILDINGS[t.b].hp;
    const top = HEIGHT[t.b] ?? 0;
    const [sx, sy] = cam.project(kx(k) + 0.5, ky(k) + 0.5, top);
    if (t.hp < max) bar(ctx, sx - w / 2, sy - 12, w, 4, t.hp / max, C.hpFg);
    if (t.b === Building.Turret && t.ammo > 0) bar(ctx, sx - w / 2, sy - 7, w, 3, t.ammo / TURRET.maxAmmo, C.turret);
  }
  for (const e of world.enemies) {
    if (e.hp >= e.maxHp) continue;
    const [sx, sy] = cam.project(lerp(e.prevX, e.x, alpha), lerp(e.prevY, e.y, alpha), 0.32);
    bar(ctx, sx - w / 2, sy - cam.scale * 0.15 - 8, w, 3, e.hp / e.maxHp, C.hpFg);
  }
}

// ---------------- 3D primitives ----------------

type P3 = [number, number, number];

function quad(ctx: CanvasRenderingContext2D, cam: Proj, pts: P3[], color: string, outline = true): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  pts.forEach(([x, y, z], i) => {
    const [sx, sy] = cam.project(x, y, z);
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  });
  ctx.closePath();
  ctx.fill();
  if (outline) {
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = inkW(cam);
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

function tri(ctx: CanvasRenderingContext2D, cam: Proj, a: P3, b: P3, c: P3, color: string): void {
  quad(ctx, cam, [a, b, c], color);
}

/** Square pyramid: left, right and front faces (the back one hides behind them). */
function pyramid(
  ctx: CanvasRenderingContext2D,
  cam: Proj,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  z0: number,
  apex: P3,
  base: string,
): void {
  tri(ctx, cam, [x0, y0, z0], [x0, y1, z0], apex, shade(base, 0.82));
  tri(ctx, cam, [x1, y0, z0], [x1, y1, z0], apex, shade(base, 0.92));
  tri(ctx, cam, [x0, y1, z0], [x1, y1, z0], apex, shade(base, 0.7));
}

/** Axis-aligned box: front (+y) face and top — the side faces are edge-on. */
function prism(
  ctx: CanvasRenderingContext2D,
  cam: Proj,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  z0: number,
  z1: number,
  base: string,
): void {
  quad(ctx, cam, [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], shade(base, 0.74));
  quad(ctx, cam, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], base);
}

function cylinder(
  ctx: CanvasRenderingContext2D,
  cam: Proj,
  cx: number,
  cy: number,
  z0: number,
  z1: number,
  r: number,
  base: string,
): void {
  const rx = r * cam.scale;
  const ry = r * cam.scale * DEPTH;
  const [bx, by] = cam.project(cx, cy, z0);
  const [tx, ty] = cam.project(cx, cy, z1);
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = inkW(cam);
  ctx.fillStyle = shade(base, 0.72);
  ctx.beginPath();
  ctx.ellipse(bx, by, rx, ry, 0, 0, Math.PI);
  ctx.lineTo(tx - rx, ty);
  ctx.ellipse(tx, ty, rx, ry, 0, Math.PI, 0, true);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = base;
  ctx.beginPath();
  ctx.ellipse(tx, ty, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // cartoon highlight
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.ellipse(tx - rx * 0.3, ty - ry * 0.25, rx * 0.35, ry * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
}

function raisedArrow(
  ctx: CanvasRenderingContext2D,
  cam: Proj,
  cx: number,
  cy: number,
  z: number,
  d: number,
  size: number,
  color: string,
): void {
  quad(ctx, cam, arrowPoints(cx, cy, d, size).map(([x, y]) => [x, y, z] as P3), color);
}

function bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, f: number, color: string): void {
  ctx.fillStyle = C.hpBg;
  ctx.beginPath();
  ctx.rect(x - 1, y - 1, w + 2, h + 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.rect(x, y, Math.max(h, w * Math.max(0, Math.min(1, f))), h);
  ctx.fill();
}

const shadeCache = new Map<string, string>();
export function shade(hex: string, f: number): string {
  const k = hex + f;
  let out = shadeCache.get(k);
  if (!out) {
    const n = parseInt(hex.slice(1, 7), 16);
    const r = Math.round(((n >> 16) & 255) * f);
    const g = Math.round(((n >> 8) & 255) * f);
    const b = Math.round((n & 255) * f);
    out = `rgb(${r},${g},${b})`;
    shadeCache.set(k, out);
  }
  return out;
}

// ---------------- helpers ----------------

export function isDirected(world: World, x: number, y: number): boolean {
  const t = world.grid.get(key(x, y));
  return t !== undefined && BUILDINGS[t.b].directed;
}

// Tiles within build reach, recomputed only when buildings change.
let reachCache: { world: World | null; version: number; set: Set<number> } = {
  world: null,
  version: -1,
  set: new Set(),
};
export function reachSet(world: World): Set<number> {
  if (reachCache.world === world && reachCache.version === world.grid.version) return reachCache.set;
  const set = new Set<number>();
  const r = MAP.buildReach;
  for (const k of world.grid.tiles.keys()) {
    const x = kx(k);
    const y = ky(k);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) set.add(key(x + dx, y + dy));
  }
  reachCache = { world, version: world.grid.version, set };
  return set;
}

function inView(k: number, v: View): boolean {
  const x = kx(k);
  const y = ky(k);
  return x >= v.x0 && x <= v.x1 && y >= v.y0 && y <= v.y1;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// =====================================================================
// Day / night
// =====================================================================

/**
 * Shadow offset per unit of height. Swings from +x (morning) to +y (evening),
 * shortest at noon; long shadows at the ends sell the time of day.
 */
export function sunVector(world: World): [number, number] {
  const p = Math.min(1, Math.max(0, (world.dayPhase - DAY.dawnEnd * 0.5) / (DAY.nightStart - DAY.dawnEnd)));
  const ang = p * (Math.PI / 2);
  const len = 0.45 + 1.6 * Math.abs(p - 0.5) * 2;
  return [Math.cos(ang) * len, Math.sin(ang) * len];
}

/** Square footprint swept along (sx, sy) ≥ 0: its hull is this hexagon (ground coords). */
export function shadowHex(x: number, y: number, h: number, sx: number, sy: number): [number, number][] {
  const a = x + 0.08;
  const b = x + 0.92;
  const c = y + 0.08;
  const d = y + 0.92;
  const u = sx * h;
  const w = sy * h;
  return [[a, c], [b, c], [b + u, c + w], [b + u, d + w], [a + u, d + w], [a, d]];
}

export interface LightSource {
  x: number;
  y: number;
  r: number;
  color: string | null;
}

/** Light sources at night: core, armed turrets, furnaces, miners. */
export function lightSources(world: World, v: View): LightSource[] {
  const lights: LightSource[] = [];
  const flicker = 0.92 + 0.08 * Math.sin(world.tickCount * 0.7);
  const lv: View = { x0: v.x0 - 5, y0: v.y0 - 5, x1: v.x1 + 5, y1: v.y1 + 5 };
  for (const [k, t] of world.grid.tiles) {
    if (!inView(k, lv)) continue;
    const x = kx(k) + 0.5;
    const y = ky(k) + 0.5;
    switch (t.b) {
      case Building.Core:
        lights.push({ x, y, r: 4.8, color: 'rgba(111,224,192,0.10)' });
        break;
      case Building.Turret:
        if (t.ammo > 0) lights.push({ x, y, r: 2.4, color: null });
        break;
      case Building.Furnace:
        lights.push({ x, y, r: t.cd > 0 ? 2.3 * flicker : 1.1, color: t.cd > 0 ? 'rgba(251,146,60,0.16)' : null });
        break;
      case Building.Miner:
        lights.push({ x, y, r: 1.1, color: null });
        break;
    }
  }
  return lights;
}

/** Sun shadows: each building's footprint swept along the sun direction. */
function drawShadows(ctx: CanvasRenderingContext2D, world: World, cam: Camera, v: View): void {
  const light = world.daylight;
  if (light <= 0.02) return;
  const [sx, sy] = sunVector(world);

  ctx.fillStyle = `rgba(40,28,14,${(0.26 * light).toFixed(3)})`;
  ctx.beginPath();
  for (const [k, tile] of world.grid.tiles) {
    if (isBelt(tile.b) || !inView(k, v)) continue;
    const h = HEIGHT[tile.b] ?? 0.5;
    shadowHex(kx(k), ky(k), h, sx, sy).forEach(([px0, py0], i) => {
      const [px, py] = cam.project(px0, py0, 0);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
  }
  ctx.fill();
}

let darkCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;

/**
 * Night: a darkness layer with holes punched by light sources (core, armed
 * turrets, burning furnaces, miners), plus a warm tint at dawn/dusk and
 * emissive details (enemy eyes, furnace mouths) drawn on top of the dark.
 */
function drawLighting(
  ctx: CanvasRenderingContext2D,
  world: World,
  cam: Camera,
  alpha: number,
  dpr: number,
  cssW: number,
  cssH: number,
  v: View,
): void {
  const light = world.daylight;
  const dark = 1 - light;

  // Golden hour tint, strongest mid-transition.
  const golden = light > 0 && light < 1 ? Math.sin(light * Math.PI) : 0;
  if (golden > 0.01) {
    ctx.fillStyle = `rgba(255,128,48,${(0.16 * golden).toFixed(3)})`;
    ctx.fillRect(0, 0, cssW, cssH);
  }
  if (dark <= 0.01) return;

  // Half-res mask: it's all soft gradients, so it upscales invisibly at 1/4 the fill cost.
  const ms = dpr * 0.5;
  const W = Math.round(cssW * ms);
  const H = Math.round(cssH * ms);
  if (!darkCanvas || darkCanvas.width !== W || darkCanvas.height !== H) {
    darkCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : document.createElement('canvas');
    darkCanvas.width = W;
    darkCanvas.height = H;
  }
  const dctx = darkCanvas.getContext('2d') as CanvasRenderingContext2D;
  dctx.setTransform(ms, 0, 0, ms, 0, 0);
  dctx.globalCompositeOperation = 'source-over';
  dctx.clearRect(0, 0, cssW, cssH);
  dctx.fillStyle = `rgba(22,16,34,${(0.74 * dark).toFixed(3)})`;
  dctx.fillRect(0, 0, cssW, cssH);

  const lights = lightSources(world, v);

  dctx.globalCompositeOperation = 'destination-out';
  for (const l of lights) isoGlow(dctx, cam, l.x, l.y, l.r, 'rgba(0,0,0,1)');
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(darkCanvas as CanvasImageSource, 0, 0, Math.round(cssW * dpr), Math.round(cssH * dpr));
  ctx.restore();

  // Coloured light on top (additive), scaled by darkness.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = dark;
  for (const l of lights) if (l.color) isoGlow(ctx, cam, l.x, l.y, l.r * 0.8, l.color);
  ctx.restore();

  // Emissive bits that should read through the dark.
  ctx.save();
  ctx.globalAlpha = Math.min(1, dark * 1.3);
  for (const [k, t] of world.grid.tiles) {
    if (t.b !== Building.Furnace || t.cd <= 0 || !inView(k, v)) continue;
    const x = kx(k);
    const y = ky(k);
    furnaceMouth(ctx, cam, x, y, t, C.furnaceHot);
  }
  ctx.fillStyle = '#ffe066';
  const eye = Math.max(1.5, cam.scale * 0.03);
  for (const e of world.enemies) {
    const [bx, by] = cam.project(lerp(e.prevX, e.x, alpha), lerp(e.prevY, e.y, alpha), 0.34);
    ctx.beginPath();
    ctx.arc(bx - eye * 1.8, by, eye, 0, Math.PI * 2);
    ctx.arc(bx + eye * 1.8, by, eye, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

const glowSprites = new Map<string, HTMLCanvasElement | OffscreenCanvas>();
/** 128px radial falloff in one colour, built once per colour. */
function glowSprite(color: string): HTMLCanvasElement | OffscreenCanvas {
  let c = glowSprites.get(color);
  if (!c) {
    const n = 128;
    c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(n, n) : document.createElement('canvas');
    c.width = n;
    c.height = n;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    grad.addColorStop(0, color);
    grad.addColorStop(0.55, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, n, n);
    glowSprites.set(color, c);
  }
  return c;
}

/** Radial falloff on the ground plane (an ellipse in iso), radius r in tiles. */
function isoGlow(
  c: CanvasRenderingContext2D,
  cam: Camera,
  x: number,
  y: number,
  r: number,
  color: string,
): void {
  const [sx, sy] = cam.project(x, y, 0);
  const rx = r * cam.scale;
  c.drawImage(glowSprite(color) as CanvasImageSource, sx - rx, sy - rx * DEPTH, rx * 2, rx * 2 * DEPTH);
}


// =====================================================================
// Toolbar icons: the same renderer, one tile, so buttons look like the thing
// you're about to build.
// =====================================================================

export function drawToolIcon(canvas: HTMLCanvasElement, tool: Exclude<Tool, 'select' | 'remove'>): void {
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth || 44;
  const sizeH = canvas.clientHeight || 40;
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(sizeH * dpr);
  const ctx = canvas.getContext('2d')!;
  const b = TOOL_BUILDING[tool];
  const h = HEIGHT[b] ?? 0;
  // Fit one tile plus the building's height: s wide, s·(DEPTH + h·RISE) tall.
  const s = Math.min(size * 0.86, (sizeH * 0.94) / (DEPTH + h * RISE));
  const ax = (size - s) / 2;
  const ay = (sizeH - s * (DEPTH + h * RISE)) / 2 + h * s * RISE;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, sizeH);

  // Ground tile
  ctx.setTransform(dpr * s, 0, 0, dpr * s * DEPTH, dpr * ax, dpr * ay);
  ctx.fillStyle = tool === 'miner' ? T.oreGround : T.landAlt;
  ctx.fillRect(0, 0, 1, 1);
  if (tool === 'miner') {
    ctx.fillStyle = T.ore;
    for (const [ox, oy] of [[0.2, 0.25], [0.75, 0.3], [0.3, 0.8], [0.8, 0.75]]) {
      ctx.beginPath();
      ctx.arc(ox, oy, 0.08, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (isBelt(b)) {
    const ink = 2.2 / s;
    paintBelt(ctx, 0, 0, b, 0, 0.3, ink);
    paintItem(ctx, 0.7, 0.5, Item.Iron, ink);
    return;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const tile: Tile = { b, hp: 1, dir: 1, cd: 40, ammo: 1, inp: 0, out: 0, item: 0, prog: 0 };
  drawBuilding(ctx, projAt(s, ax, ay), 0, 0, tile);
}
