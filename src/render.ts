// Isometric, read-only view of the world. Never mutates simulation state
// (world.syncFlow() only refreshes a derived cache).
//
// Two passes:
//  1. Ground (affine iso transform, tile units, z = 0): terrain, belts, items,
//     routes, spawn markers, previews.
//  2. Screen space with cam.project(x, y, z): raised things (buildings as
//     extruded prisms, enemies), sorted back-to-front by x + y.

import { Camera } from './camera';
import { BELT_TICKS, BUILDINGS, Building, DAY, isBelt, DIR_X, DIR_Y, Item, MAP, TURRET, type Placeable } from './sim/defs';
import { NO_NEXT } from './sim/flowfield';
import { TerrainCache, paintTerrain } from './terrainLayer';

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

// Cartoon palette: saturated, warm, two-tone shading + dark ink outlines.
const C = {
  ink: '#2b2340',
  bg: '#5aa65a',
  land: '#8fd16a',
  landAlt: '#86c962',
  reachTint: 'rgba(255,255,230,0.16)',
  grid: 'rgba(43,35,64,0.07)',
  tuft: '#5ea84a',
  flowerA: '#fff4d6',
  flowerB: '#ffd34d',
  bank: '#e8c27f',
  bankDark: '#c99a5a',
  water: '#46c2e0',
  waterLight: '#7fdcf0',
  foam: '#e9fbff',
  ore: '#7a5235',
  oreHi: '#c08a5a',
  oreGround: '#d4a46a',
  spawn: '#ff4f64',
  path: 'rgba(255,79,100,0.55)',
  core: '#4fb3ff',
  wall: '#b9b3c9',
  turretBase: '#8a7a6a',
  turret: '#ffc93c',
  belt: '#6d7287',
  fastBelt: '#5a6fb0',
  fastBeltRail: '#ffc93c',
  fastBeltMark: '#d9e6ff',
  oreRich: '#d39a63',
  beltMark: '#c9cde0',
  miner: '#d08b4f',
  furnace: '#e8664a',
  furnaceHot: '#ffd166',
  iron: '#a86d43',
  plate: '#e6ebf2',
  noAmmo: '#ff4f64',
  enemy: '#ff5d73',
  enemyLight: '#ffb3be',
  shadow: 'rgba(30,50,30,0.25)',
  shot: '#fff2a8',
  sel: '#fff2a8',
  hpBg: 'rgba(43,35,64,0.75)',
  hpFg: '#5be37f',
  range: 'rgba(255,201,60,0.8)',
  ok: 'rgba(91,227,127,0.45)',
  bad: 'rgba(255,79,100,0.45)',
  plan: 'rgba(79,179,255,0.35)',
  planEdge: '#2f8fe0',
  planBad: 'rgba(255,79,100,0.5)',
};

/** Outline width in CSS px for a given zoom. */
const inkW = (cam: Camera) => Math.max(1.1, cam.scale * 0.026);

interface View {
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
  cam.applyGround(ctx, dpr);
  if (!cached) paintTerrain(ctx, world, v.x0, v.y0, v.x1, v.y1, cam.scale);
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
  for (const [k, t] of grid.tiles) {
    if (!isBelt(t.b) || !inView(k, v)) continue;
    const x = kx(k);
    const y = ky(k);
    const fast = t.b === Building.FastBelt;
    const period = BELT_TICKS[t.b]!;
    const phase = (world.tickCount % period) / period;
    ctx.fillStyle = fast ? C.fastBelt : C.belt;
    ctx.fillRect(x + 0.08, y + 0.08, 0.84, 0.84);
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1.6 * gpx;
    ctx.strokeRect(x + 0.08, y + 0.08, 0.84, 0.84);
    if (fast) {
      ctx.fillStyle = C.fastBeltRail;
      ctx.fillRect(x + 0.1 + (DIR_X[t.dir] === 0 ? 0 : 0), y + 0.1, DIR_X[t.dir] === 0 ? 0.08 : 0.8, DIR_X[t.dir] === 0 ? 0.8 : 0.08);
      ctx.fillRect(
        DIR_X[t.dir] === 0 ? x + 0.82 : x + 0.1,
        DIR_X[t.dir] === 0 ? y + 0.1 : y + 0.82,
        DIR_X[t.dir] === 0 ? 0.08 : 0.8,
        DIR_X[t.dir] === 0 ? 0.8 : 0.08,
      );
    }
    for (let i = 0; i < 2; i++) {
      const s = ((i * 0.5 + phase) % 1) - 0.5;
      groundArrow(ctx, x + 0.5 + DIR_X[t.dir] * s * 0.7, y + 0.5 + DIR_Y[t.dir] * s * 0.7, t.dir, 0.15, fast ? C.fastBeltMark : C.beltMark);
    }
  }
  for (const [k, t] of grid.tiles) {
    if (!isBelt(t.b) || !t.item || !inView(k, v)) continue;
    const s = t.prog / BELT_TICKS[t.b]! - 0.5;
    const cx = kx(k) + 0.5 + DIR_X[t.dir] * s;
    const cy = ky(k) + 0.5 + DIR_Y[t.dir] * s;
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1.6 * gpx;
    ctx.beginPath();
    if (t.item === Item.Plate) {
      ctx.fillStyle = C.plate;
      ctx.roundRect(cx - 0.16, cy - 0.16, 0.32, 0.32, 0.06);
    } else {
      ctx.fillStyle = C.iron;
      ctx.arc(cx, cy, 0.16, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
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

function drawPaths(ctx: CanvasRenderingContext2D, world: World): void {
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

function groundArrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, d: number, size: number, color: string): void {
  const pts = arrowPoints(cx, cy, d, size);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();
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

const AIM_STEPS = 16;
const SPRITE_TOP = 1.7; // tallest silhouette, in tile heights
const SPRITE_SETTLE = 6;

interface Sprite {
  img: CanvasImageSource;
  w: number;
  h: number;
  /** Device px of the tile's top vertex inside the sprite. */
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
    const h = Math.ceil(S / 2 + (SPRITE_TOP * S) / 2 + 2 * pad);
    const ax = pad + S / 2;
    const ay = pad + (SPRITE_TOP * S) / 2;
    const canvas: HTMLCanvasElement | OffscreenCanvas =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const g = canvas.getContext('2d') as CanvasRenderingContext2D;
    // A camera whose (0,0,0) lands on (ax, ay), in device px.
    const sc = new Camera();
    sc.resize(w, h);
    sc.scale = S;
    const c0 = ((h / 2 - ay) * 2) / S;
    sc.centerOn(c0, c0);
    drawBuilding(g, sc, 0, 0, t, 0, aim, false);
    const img: CanvasImageSource = canvas instanceof HTMLCanvasElement ? canvas : canvas.transferToImageBitmap();
    sp = { img, w, h, ax, ay };
    this.map.set(id, sp);
    return sp;
  },
};

function blitBuilding(ctx: CanvasRenderingContext2D, cam: Camera, dpr: number, x: number, y: number, t: Tile, time: number): void {
  if (t.b === Building.Core) {
    drawBuilding(ctx, cam, x, y, t, time);
    return;
  }
  let aim: number | undefined;
  let variant = '';
  if (t.b === Building.Turret) {
    const a = turretAim.get(key(x, y)) ?? Math.PI / 4;
    const q = Math.round((a / (Math.PI * 2)) * AIM_STEPS) % AIM_STEPS;
    aim = (q / AIM_STEPS) * Math.PI * 2;
    variant = `${q}${t.ammo === 0 ? 'e' : ''}`;
  } else if (t.b === Building.Furnace || t.b === Building.Miner) {
    variant = t.cd > 0 ? 'on' : 'off';
  }
  const sp = sprites.get(t, aim, variant);
  const k = cam.scale * dpr / sprites.scale / dpr; // sprite device px -> CSS px
  const [tx, ty] = cam.project(x, y, 0);
  ctx.drawImage(sp.img, tx - sp.ax * k, ty - sp.ay * k, sp.w * k, sp.h * k);
  // Live effects on top of the baked body.
  if (t.b === Building.Furnace && t.cd > 0) {
    for (let i = 0; i < 3; i++) {
      const ph = (time / 50 + i / 3) % 1;
      const [sx, sy] = cam.project(x + 0.25 - ph * 0.15, y + 0.25 - ph * 0.15, 1.2 + ph * 0.7);
      ctx.fillStyle = `rgba(160,160,170,${(0.45 * (1 - ph)).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(sx, sy, cam.scale * (0.05 + 0.07 * ph), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawRaised(ctx: CanvasRenderingContext2D, world: World, cam: Camera, ui: UiState, alpha: number, v: View, dpr: number): void {
  for (const sh of world.shots) {
    turretAim.set(key(Math.floor(sh.fromX), Math.floor(sh.fromY)), Math.atan2(sh.toY - sh.fromY, sh.toX - sh.fromX));
  }
  sprites.tick(cam.scale * dpr);
  const list: Drawable[] = [];
  for (const [k, t] of world.grid.tiles) {
    if (isBelt(t.b) || !inView(k, v)) continue;
    const x = kx(k);
    const y = ky(k);
    list.push({ depth: x + y + 1, draw: () => blitBuilding(ctx, cam, dpr, x, y, t, world.tickCount) });
  }
  for (const e of world.enemies) {
    const ex = lerp(e.prevX, e.x, alpha);
    const ey = lerp(e.prevY, e.y, alpha);
    list.push({ depth: ex + ey, draw: () => drawEnemy(ctx, cam, ex, ey, e) });
  }
  for (const [k, p] of ui.plans.map) {
    if (p.kind !== 'place' || isBelt(p.b) || !inView(k, v)) continue;
    const x = kx(k);
    const y = ky(k);
    const ghost: Tile = { b: p.b, hp: 1, dir: p.dir, cd: 0, ammo: 1, inp: 0, out: 0, item: 0, prog: 0 };
    const ok = ui.planEval?.ok.has(k) ?? false;
    list.push({
      depth: x + y + 1,
      draw: () => {
        ctx.globalAlpha = ok ? 0.45 : 0.25;
        blitBuilding(ctx, cam, dpr, x, y, ghost, 0);
        ctx.globalAlpha = 1;
      },
    });
  }
  list.sort((a, b) => a.depth - b.depth);
  for (const d of list) d.draw();
}

/** Top of each building's silhouette (shadows, bars, icon framing). */
export const HEIGHT: Partial<Record<Building, number>> = {
  [Building.Core]: 1.6,
  [Building.Wall]: 0.62,
  [Building.Miner]: 1.05,
  [Building.Furnace]: 1.15,
  [Building.Turret]: 0.6,
};

/** Last aim angle per turret (render-side only, from the shots it fired). */
const turretAim = new Map<number, number>();

function drawBuilding(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
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
      // Stepped plinth + floating octahedral crystal.
      prism(ctx, cam, x + 0.04, y + 0.04, x + 0.96, y + 0.96, 0, 0.16, '#5d8fcf');
      prism(ctx, cam, x + 0.17, y + 0.17, x + 0.83, y + 0.83, 0.16, 0.3, '#82b4ea');
      const bob = 0.05 * Math.sin(time / 28);
      const w = 0.24;
      const zb = 0.42 + bob;
      const zm = 0.86 + bob;
      const zt = 1.55 + bob;
      // lower half (S, E faces), then upper half
      tri(ctx, cam, [x + 0.5 - w, cy + w, zm], [cx + w, cy + w, zm], [cx, cy, zb], shade(C.core, 0.55));
      tri(ctx, cam, [cx + w, cy - w, zm], [cx + w, cy + w, zm], [cx, cy, zb], shade(C.core, 0.7));
      tri(ctx, cam, [cx - w, cy + w, zm], [cx + w, cy + w, zm], [cx, cy, zt], shade(C.core, 0.85));
      tri(ctx, cam, [cx + w, cy - w, zm], [cx + w, cy + w, zm], [cx, cy, zt], '#c4ecff');
      break;
    }
    case Building.Wall: {
      // Block with battlements.
      prism(ctx, cam, x + 0.03, y + 0.03, x + 0.97, y + 0.97, 0, 0.42, C.wall);
      const m = 0.26;
      const z0 = 0.42;
      const z1 = 0.62;
      prism(ctx, cam, x + 0.05, y + 0.05, x + 0.05 + m, y + 0.05 + m, z0, z1, C.wall);
      prism(ctx, cam, x + 0.95 - m, y + 0.05, x + 0.95, y + 0.05 + m, z0, z1, C.wall);
      prism(ctx, cam, x + 0.05, y + 0.95 - m, x + 0.05 + m, y + 0.95, z0, z1, C.wall);
      prism(ctx, cam, x + 0.95 - m, y + 0.95 - m, x + 0.95, y + 0.95, z0, z1, C.wall);
      break;
    }
    case Building.Miner: {
      // Base plate, output chute, pyramid drill tower.
      prism(ctx, cam, x + 0.08, y + 0.08, x + 0.92, y + 0.92, 0, 0.2, '#a8693e');
      const front = t.dir === 0 || t.dir === 1;
      if (!front) chute(ctx, cam, cx, cy, t.dir);
      const working = t.cd > 0;
      const zTop = 1.0 + (working ? 0.03 * Math.sin(time / 3) : 0);
      pyramid(ctx, cam, x + 0.2, y + 0.2, x + 0.8, y + 0.8, 0.2, [cx, cy, zTop], C.miner);
      // Pulley at the apex
      const [px, py] = cam.project(cx, cy, zTop);
      ctx.fillStyle = working ? '#ffd166' : '#7a4a2a';
      ctx.beginPath();
      ctx.arc(px, py, Math.max(1.8, cam.scale * 0.05), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = inkW(cam);
      ctx.stroke();
      if (front) chute(ctx, cam, cx, cy, t.dir);
      break;
    }
    case Building.Furnace: {
      // Brick body, chimney at the back corner, glowing mouth on the output side.
      prism(ctx, cam, x + 0.08, y + 0.08, x + 0.92, y + 0.92, 0, 0.55, C.furnace);
      prism(ctx, cam, x + 0.14, y + 0.14, x + 0.36, y + 0.36, 0.55, 1.15, '#b8473a');
      furnaceMouth(ctx, cam, x, y, t, t.cd > 0 ? C.furnaceHot : '#2a1006');
      raisedArrow(ctx, cam, cx + 0.12, cy + 0.12, 0.55, t.dir, 0.16, '#3b1607');
      if (fx && t.cd > 0) {
        // Smoke puffs
        for (let i = 0; i < 3; i++) {
          const ph = (time / 50 + i / 3) % 1;
          const [sx, sy] = cam.project(x + 0.25 - ph * 0.15, y + 0.25 - ph * 0.15, 1.2 + ph * 0.7);
          ctx.fillStyle = `rgba(160,160,170,${(0.45 * (1 - ph)).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(sx, sy, cam.scale * (0.05 + 0.07 * ph), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
    case Building.Turret: {
      // Round base, rotating head, barrel towards the last target.
      cylinder(ctx, cam, cx, cy, 0, 0.24, 0.38, C.turretBase);
      const aim = aimOverride ?? turretAim.get(key(x, y)) ?? Math.PI / 4;
      const empty = t.ammo === 0;
      const head = empty ? '#cdb98a' : C.turret;
      const bx = cx + Math.cos(aim) * 0.48;
      const by = cy + Math.sin(aim) * 0.48;
      const barrelFront = Math.cos(aim) + Math.sin(aim) > 0;
      const barrel = () => {
        const [ax, ay] = cam.project(cx, cy, 0.42);
        const [ex, ey] = cam.project(bx, by, 0.44);
        ctx.lineCap = 'round';
        const bw = Math.max(2, cam.scale * 0.085);
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = bw + inkW(cam) * 2;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        ctx.strokeStyle = '#6b6580';
        ctx.lineWidth = bw;
        ctx.stroke();
        ctx.lineCap = 'butt';
      };
      if (!barrelFront) barrel();
      cylinder(ctx, cam, cx, cy, 0.24, 0.5, 0.24, head);
      if (barrelFront) barrel();
      if (empty) {
        const [sx, sy] = cam.project(cx, cy, 0.5);
        ctx.strokeStyle = C.noAmmo;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(sx, sy, 0.24 * cam.scale * 0.707, 0.24 * cam.scale * 0.354, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
  }
}

/** Glowing furnace mouth on the face it outputs through (or the top edge if that face is hidden). */
function furnaceMouth(ctx: CanvasRenderingContext2D, cam: Camera, x: number, y: number, t: Tile, color: string): void {
  const cx = x + 0.5;
  const cy = y + 0.5;
  const z0 = 0.1;
  const z1 = 0.34;
  if (t.dir === 0) quad(ctx, cam, [[x + 0.92, cy - 0.17, z0], [x + 0.92, cy + 0.17, z0], [x + 0.92, cy + 0.17, z1], [x + 0.92, cy - 0.17, z1]], color, false);
  else if (t.dir === 1) quad(ctx, cam, [[cx - 0.17, y + 0.92, z0], [cx + 0.17, y + 0.92, z0], [cx + 0.17, y + 0.92, z1], [cx - 0.17, y + 0.92, z1]], color, false);
  else if (t.dir === 2) quad(ctx, cam, [[x + 0.1, cy - 0.17, 0.55], [x + 0.3, cy - 0.17, 0.55], [x + 0.3, cy + 0.17, 0.55], [x + 0.1, cy + 0.17, 0.55]], color, false);
  else quad(ctx, cam, [[cx - 0.17, y + 0.1, 0.55], [cx + 0.17, y + 0.1, 0.55], [cx + 0.17, y + 0.3, 0.55], [cx - 0.17, y + 0.3, 0.55]], color, false);
}

/** Miner's output chute: a short box from the centre towards the output side. */
function chute(ctx: CanvasRenderingContext2D, cam: Camera, cx: number, cy: number, d: number): void {
  const fx = DIR_X[d];
  const fy = DIR_Y[d];
  const w = 0.11;
  const ax = cx + fx * 0.2;
  const ay = cy + fy * 0.2;
  const bx = cx + fx * 0.5;
  const by = cy + fy * 0.5;
  prism(ctx, cam, Math.min(ax, bx) - (fx ? 0 : w), Math.min(ay, by) - (fy ? 0 : w), Math.max(ax, bx) + (fx ? 0 : w), Math.max(ay, by) + (fy ? 0 : w), 0.12, 0.3, '#7a4a2a');
}

function drawEnemy(ctx: CanvasRenderingContext2D, cam: Camera, x: number, y: number, e: Enemy): void {
  const s = cam.scale;
  // Hop: squash at the bottom, stretch in the air.
  const hop = Math.abs(Math.sin((x + y) * 4 + e.id));
  const sq = 1 + (1 - hop) * 0.18;
  const [gx, gy] = cam.project(x, y, 0);
  ctx.fillStyle = C.shadow;
  ctx.beginPath();
  ctx.ellipse(gx, gy, s * 0.17, s * 0.085, 0, 0, Math.PI * 2);
  ctx.fill();
  const [bx, by] = cam.project(x, y, 0.16 + hop * 0.14);
  const rx = s * 0.17 * sq;
  const ry = (s * 0.15) / sq;
  ctx.fillStyle = C.enemy;
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = inkW(cam);
  ctx.beginPath();
  // dome-shaped slime: round top, flatter bottom
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
  // Eyes looking where it's heading (screen space)
  const [hx, hy] = cam.project(x + (e.x - e.prevX) * 30, y + (e.y - e.prevY) * 30, 0);
  const look = Math.atan2(hy - gy, hx - gx);
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

function quad(ctx: CanvasRenderingContext2D, cam: Camera, pts: P3[], color: string, outline = true): void {
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

function tri(ctx: CanvasRenderingContext2D, cam: Camera, a: P3, b: P3, c: P3, color: string): void {
  quad(ctx, cam, [a, b, c], color);
}

/** Square pyramid; only the faces the viewer sees (+y, +x). */
function pyramid(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  z0: number,
  apex: P3,
  base: string,
): void {
  tri(ctx, cam, [x0, y1, z0], [x1, y1, z0], apex, shade(base, 0.7));
  tri(ctx, cam, [x1, y0, z0], [x1, y1, z0], apex, shade(base, 0.85));
}

/** Axis-aligned box; only the three faces the viewer sees (+y, +x, top). */
function prism(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  z0: number,
  z1: number,
  base: string,
): void {
  quad(ctx, cam, [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], shade(base, 0.7));
  quad(ctx, cam, [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], shade(base, 0.86));
  quad(ctx, cam, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], base);
}

function cylinder(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  cx: number,
  cy: number,
  z0: number,
  z1: number,
  r: number,
  base: string,
): void {
  const rx = r * cam.scale * 0.707;
  const ry = r * cam.scale * 0.354;
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
  cam: Camera,
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
  ctx.roundRect(x - 1, y - 1, w + 2, h + 2, (h + 2) / 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(h, w * Math.max(0, Math.min(1, f))), h, h / 2);
  ctx.fill();
}

const shadeCache = new Map<string, string>();
function shade(hex: string, f: number): string {
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
function reachSet(world: World): Set<number> {
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

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// =====================================================================
// Day / night
// =====================================================================

/** Sun shadows: each building's footprint swept along the sun direction. */
function drawShadows(ctx: CanvasRenderingContext2D, world: World, cam: Camera, v: View): void {
  const light = world.daylight;
  if (light <= 0.02) return;
  const t = world.dayPhase;
  // 0 at sunrise, 1 at sunset (clamped for dawn/dusk).
  const p = Math.min(1, Math.max(0, (t - DAY.dawnEnd * 0.5) / (DAY.nightStart - DAY.dawnEnd)));
  // Shadows swing from pointing +x (morning, down-right) to +y (evening, down-left),
  // shortest at noon. Long shadows at the ends sell the time of day.
  const ang = p * (Math.PI / 2);
  const len = 0.45 + 1.6 * Math.abs(p - 0.5) * 2;
  const sx = Math.cos(ang) * len;
  const sy = Math.sin(ang) * len;

  ctx.fillStyle = `rgba(30,50,30,${(0.24 * light).toFixed(3)})`;
  ctx.beginPath();
  for (const [k, tile] of world.grid.tiles) {
    if (isBelt(tile.b) || !inView(k, v)) continue;
    const h = HEIGHT[tile.b] ?? 0.5;
    const x = kx(k);
    const y = ky(k);
    // Square footprint swept along (sx, sy), both ≥ 0: its hull is this hexagon.
    const a = x + 0.08;
    const b = x + 0.92;
    const c = y + 0.08;
    const d = y + 0.92;
    const u = sx * h;
    const w = sy * h;
    const hex: [number, number][] = [[a, c], [b, c], [b + u, c + w], [b + u, d + w], [a + u, d + w], [a, d]];
    hex.forEach(([px0, py0], i) => {
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
  dctx.fillStyle = `rgba(24,22,70,${(0.72 * dark).toFixed(3)})`;
  dctx.fillRect(0, 0, cssW, cssH);

  const lights: { x: number; y: number; r: number; color: string | null }[] = [];
  const flicker = 0.92 + 0.08 * Math.sin(world.tickCount * 0.7);
  const lv: View = { x0: v.x0 - 5, y0: v.y0 - 5, x1: v.x1 + 5, y1: v.y1 + 5 };
  for (const [k, t] of world.grid.tiles) {
    if (!inView(k, lv)) continue;
    const x = kx(k) + 0.5;
    const y = ky(k) + 0.5;
    switch (t.b) {
      case Building.Core:
        lights.push({ x, y, r: 4.8, color: 'rgba(79,179,255,0.10)' });
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
  const rx = r * cam.scale * 0.707;
  c.drawImage(glowSprite(color) as CanvasImageSource, sx - rx, sy - rx / 2, rx * 2, rx);
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
  const cam = new Camera();
  cam.resize(size, sizeH);
  // Fit diamond + height: vertical extent is s·(1+h)/2.
  cam.scale = Math.min(size * 0.92, (sizeH * 1.84) / (1 + h));
  cam.centerOn(0.5 - h / 2, 0.5 - h / 2);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, sizeH);

  // Ground tile
  cam.applyGround(ctx, dpr);
  ctx.fillStyle = tool === 'miner' ? C.oreGround : C.landAlt;
  ctx.fillRect(0, 0, 1, 1);
  if (tool === 'miner') {
    ctx.fillStyle = C.ore;
    for (const [ox, oy] of [[0.2, 0.25], [0.75, 0.3], [0.3, 0.8], [0.8, 0.75]]) {
      ctx.beginPath();
      ctx.arc(ox, oy, 0.08, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (isBelt(b)) {
    const fast = b === Building.FastBelt;
    ctx.fillStyle = fast ? C.fastBelt : C.belt;
    ctx.fillRect(0.1, 0.1, 0.8, 0.8);
    if (fast) {
      ctx.fillStyle = C.fastBeltRail;
      ctx.fillRect(0.1, 0.1, 0.8, 0.08);
      ctx.fillRect(0.1, 0.82, 0.8, 0.08);
    }
    for (const sOff of [-0.22, 0.18]) groundArrow(ctx, 0.5 + sOff, 0.5, 0, 0.17, fast ? C.fastBeltMark : C.beltMark);
    ctx.fillStyle = C.iron;
    ctx.beginPath();
    ctx.arc(0.72, 0.5, 0.12, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const tile: Tile = { b, hp: 1, dir: 0, cd: 40, ammo: 1, inp: 0, out: 0, item: 0, prog: 0 };
  drawBuilding(ctx, cam, 0, 0, tile);
}
