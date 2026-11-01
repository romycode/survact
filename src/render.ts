// Isometric, read-only view of the world. Never mutates simulation state
// (world.syncFlow() only refreshes a derived cache).
//
// Two passes:
//  1. Ground (affine iso transform, tile units, z = 0): terrain, belts, items,
//     routes, spawn markers, previews.
//  2. Screen space with cam.project(x, y, z): raised things (buildings as
//     extruded prisms, enemies), sorted back-to-front by x + y.

import type { Camera } from './camera';
import { BELT, BUILDINGS, Building, DIR_X, DIR_Y, FURNACE, Item, MAP, TURRET, type Placeable } from './sim/defs';
import { NO_NEXT } from './sim/flowfield';
import { key, kx, ky, type Tile } from './sim/grid';
import { Ground } from './sim/terrain';
import type { Enemy, World } from './sim/world';
import type { PlanEval, Plans } from './plans';

export type Tool = 'select' | 'wall' | 'turret' | 'belt' | 'miner' | 'furnace' | 'remove';

export const TOOL_BUILDING: Record<Exclude<Tool, 'remove' | 'select'>, Placeable> = {
  wall: Building.Wall,
  turret: Building.Turret,
  belt: Building.Belt,
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

const C = {
  bg: '#07090c',
  land: '#1a1f27',
  landAlt: '#1d232c',
  reach: '#232a35',
  grid: '#262d39',
  bank: '#2a2118',
  bankDark: '#1d1711',
  water: '#0d2c42',
  waterLight: '#154461',
  ore: '#b07a50',
  spawn: '#e5484d',
  path: '#e5484d66',
  core: '#4fb3ff',
  wall: '#7b8494',
  turretBase: '#5b5346',
  turret: '#e0b341',
  belt: '#2b323f',
  beltMark: '#8a94a6',
  miner: '#9c6b4a',
  furnace: '#b4532a',
  furnaceHot: '#fdba74',
  iron: '#b07a50',
  plate: '#d4dbe5',
  noAmmo: '#e5484d',
  enemy: '#e5484d',
  enemyLight: '#ff8a8d',
  shadow: '#00000066',
  shot: '#ffe8a3',
  sel: '#ffe8a3',
  hpBg: '#000000aa',
  hpFg: '#46d37a',
  range: '#e0b34188',
  ok: '#46d37a66',
  bad: '#e5484d66',
  plan: '#4fb3ff55',
  planEdge: '#4fb3ff',
  planBad: '#e5484d77',
};

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

  cam.applyGround(ctx, dpr);
  drawGround(ctx, world, cam, ui, v);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBanks(ctx, world, cam, v);
  drawRaised(ctx, world, cam, ui, alpha, v);
  drawShotsAndBars(ctx, world, cam, alpha, v);
}

// =====================================================================
// Ground pass (tile units)
// =====================================================================

function drawGround(ctx: CanvasRenderingContext2D, world: World, cam: Camera, ui: UiState, v: View): void {
  const { grid, terrain } = world;
  const gpx = 2 / cam.scale; // ~1 CSS px in ground units

  // Land with a subtle checker so the iso grid reads without lines.
  for (let y = v.y0; y <= v.y1; y++) {
    for (let x = v.x0; x <= v.x1; x++) {
      if (terrain.at(x, y) === Ground.Water) continue;
      ctx.fillStyle = (x + y) & 1 ? C.land : C.landAlt;
      ctx.fillRect(x, y, 1.01, 1.01);
    }
  }
  if (world.phase === 'build') {
    const reach = reachSet(world);
    ctx.fillStyle = C.reach;
    for (let y = v.y0; y <= v.y1; y++) {
      for (let x = v.x0; x <= v.x1; x++) {
        if (reach.has(key(x, y)) && terrain.at(x, y) !== Ground.Water) ctx.fillRect(x, y, 1.01, 1.01);
      }
    }
  }

  // Water sits lower: drawn here, then land banks in front of it in pass 2.
  const shimmer = world.tickCount / 40;
  for (let y = v.y0; y <= v.y1; y++) {
    for (let x = v.x0; x <= v.x1; x++) {
      if (terrain.at(x, y) !== Ground.Water) continue;
      const w = Math.sin(x * 0.9 + y * 0.6 + shimmer) > 0.6;
      ctx.fillStyle = w ? C.waterLight : C.water;
      ctx.fillRect(x, y, 1.01, 1.01);
    }
  }

  // Iron ore speckles
  ctx.fillStyle = C.ore;
  ctx.beginPath();
  for (let y = v.y0; y <= v.y1; y++) {
    for (let x = v.x0; x <= v.x1; x++) {
      if (terrain.at(x, y) !== Ground.Ore) continue;
      for (let k = 0; k < 5; k++) {
        const h = ((x * 73856093) ^ (y * 19349663) ^ (k * 83492791)) >>> 0;
        const ox = 0.18 + ((h & 255) / 255) * 0.64;
        const oy = 0.18 + (((h >> 8) & 255) / 255) * 0.64;
        const r = 0.07 + ((h >> 16) & 3) * 0.02;
        ctx.moveTo(x + ox + r, y + oy);
        ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
      }
    }
  }
  ctx.fill();

  if (cam.scale >= 28) {
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = gpx;
    ctx.beginPath();
    for (let x = v.x0; x <= v.x1 + 1; x++) {
      ctx.moveTo(x, v.y0);
      ctx.lineTo(x, v.y1 + 1);
    }
    for (let y = v.y0; y <= v.y1 + 1; y++) {
      ctx.moveTo(v.x0, y);
      ctx.lineTo(v.x1 + 1, y);
    }
    ctx.stroke();
  }

  // Predicted routes + spawn markers
  if (world.phase === 'build') drawPaths(ctx, world);
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
  const phase = world.phase === 'wave' ? (world.tickCount % BELT.ticksPerTile) / BELT.ticksPerTile : 0;
  for (const [k, t] of grid.tiles) {
    if (t.b !== Building.Belt || !inView(k, v)) continue;
    const x = kx(k);
    const y = ky(k);
    ctx.fillStyle = C.belt;
    ctx.fillRect(x + 0.1, y + 0.1, 0.8, 0.8);
    for (let i = 0; i < 2; i++) {
      const s = ((i * 0.5 + phase) % 1) - 0.5;
      groundArrow(ctx, x + 0.5 + DIR_X[t.dir] * s * 0.7, y + 0.5 + DIR_Y[t.dir] * s * 0.7, t.dir, 0.15, C.beltMark);
    }
  }
  for (const [k, t] of grid.tiles) {
    if (t.b !== Building.Belt || !t.item || !inView(k, v)) continue;
    const s = t.prog / BELT.ticksPerTile - 0.5;
    const cx = kx(k) + 0.5 + DIR_X[t.dir] * s;
    const cy = ky(k) + 0.5 + DIR_Y[t.dir] * s;
    if (t.item === Item.Plate) {
      ctx.fillStyle = C.plate;
      ctx.fillRect(cx - 0.16, cy - 0.16, 0.32, 0.32);
    } else {
      ctx.fillStyle = C.iron;
      ctx.beginPath();
      ctx.arc(cx, cy, 0.16, 0, Math.PI * 2);
      ctx.fill();
    }
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
  if (world.phase === 'build' && ui.hoverX !== NO_HOVER && ui.tool !== 'select') {
    const hx = ui.hoverX;
    const hy = ui.hoverY;
    const b = grid.building(key(hx, hy));
    const ok =
      ui.tool === 'remove'
        ? b !== Building.None && b !== Building.Core
        : world.placeError(hx, hy, TOOL_BUILDING[ui.tool]) === null || isDirected(world, hx, hy);
    ctx.fillStyle = ok ? C.ok : C.bad;
    ctx.fillRect(hx, hy, 1, 1);
    if (ui.tool === 'belt' || ui.tool === 'miner' || ui.tool === 'furnace') {
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

const BANK = 0.28; // how far water sits below land

/** Land/water edges facing the viewer (+x and +y) get a visible earth wall. */
function drawBanks(ctx: CanvasRenderingContext2D, world: World, cam: Camera, v: View): void {
  const { terrain } = world;
  for (let y = v.y0; y <= v.y1; y++) {
    for (let x = v.x0; x <= v.x1; x++) {
      if (terrain.at(x, y) === Ground.Water) continue;
      if (terrain.at(x, y + 1) === Ground.Water) {
        quad(ctx, cam, [[x, y + 1, 0], [x + 1, y + 1, 0], [x + 1, y + 1, -BANK], [x, y + 1, -BANK]], C.bankDark);
      }
      if (terrain.at(x + 1, y) === Ground.Water) {
        quad(ctx, cam, [[x + 1, y, 0], [x + 1, y + 1, 0], [x + 1, y + 1, -BANK], [x + 1, y, -BANK]], C.bank);
      }
    }
  }
}

type Drawable = { depth: number; draw: () => void };

function drawRaised(ctx: CanvasRenderingContext2D, world: World, cam: Camera, ui: UiState, alpha: number, v: View): void {
  const list: Drawable[] = [];
  for (const [k, t] of world.grid.tiles) {
    if (t.b === Building.Belt || !inView(k, v)) continue;
    const x = kx(k);
    const y = ky(k);
    list.push({ depth: x + y + 1, draw: () => drawBuilding(ctx, cam, x, y, t) });
  }
  for (const e of world.enemies) {
    const ex = lerp(e.prevX, e.x, alpha);
    const ey = lerp(e.prevY, e.y, alpha);
    list.push({ depth: ex + ey, draw: () => drawEnemy(ctx, cam, ex, ey, e) });
  }
  for (const [k, p] of ui.plans.map) {
    if (p.kind !== 'place' || p.b === Building.Belt || !inView(k, v)) continue;
    const x = kx(k);
    const y = ky(k);
    const ghost: Tile = { b: p.b, hp: 1, dir: p.dir, cd: 0, ammo: 1, inp: 0, out: 0, item: 0, prog: 0 };
    const ok = ui.planEval?.ok.has(k) ?? false;
    list.push({
      depth: x + y + 1,
      draw: () => {
        ctx.globalAlpha = ok ? 0.45 : 0.25;
        drawBuilding(ctx, cam, x, y, ghost);
        ctx.globalAlpha = 1;
      },
    });
  }
  list.sort((a, b) => a.depth - b.depth);
  for (const d of list) d.draw();
}

const HEIGHT: Partial<Record<Building, number>> = {
  [Building.Core]: 1.1,
  [Building.Wall]: 0.6,
  [Building.Miner]: 0.5,
  [Building.Furnace]: 0.7,
  [Building.Turret]: 0.3,
};

function drawBuilding(ctx: CanvasRenderingContext2D, cam: Camera, x: number, y: number, t: Tile): void {
  const h = HEIGHT[t.b] ?? 0.5;
  switch (t.b) {
    case Building.Core: {
      prism(ctx, cam, x + 0.06, y + 0.06, x + 0.94, y + 0.94, 0, h, C.core);
      // Glowing inset on top
      quad(ctx, cam, [[x + 0.3, y + 0.3, h], [x + 0.7, y + 0.3, h], [x + 0.7, y + 0.7, h], [x + 0.3, y + 0.7, h]], '#bfe4ff');
      break;
    }
    case Building.Wall:
      prism(ctx, cam, x + 0.04, y + 0.04, x + 0.96, y + 0.96, 0, h, C.wall);
      break;
    case Building.Miner:
      prism(ctx, cam, x + 0.1, y + 0.1, x + 0.9, y + 0.9, 0, h, C.miner);
      raisedArrow(ctx, cam, x + 0.5, y + 0.5, h, t.dir, 0.28, '#3a2416');
      break;
    case Building.Furnace: {
      prism(ctx, cam, x + 0.08, y + 0.08, x + 0.92, y + 0.92, 0, h, C.furnace);
      if (t.cd > 0) {
        const f = 1 - t.cd / FURNACE.ticksPerPlate;
        const r = 0.12 + 0.12 * f;
        quad(ctx, cam, [[x + 0.5 - r, y + 0.5 - r, h], [x + 0.5 + r, y + 0.5 - r, h], [x + 0.5 + r, y + 0.5 + r, h], [x + 0.5 - r, y + 0.5 + r, h]], C.furnaceHot);
      }
      raisedArrow(ctx, cam, x + 0.5, y + 0.5, h, t.dir, 0.3, '#3b1607');
      break;
    }
    case Building.Turret: {
      prism(ctx, cam, x + 0.12, y + 0.12, x + 0.88, y + 0.88, 0, h, C.turretBase);
      const empty = t.ammo === 0;
      cylinder(ctx, cam, x + 0.5, y + 0.5, h, h + 0.35, 0.3, empty ? '#7a6a3a' : C.turret);
      if (empty) {
        const [sx, sy] = cam.project(x + 0.5, y + 0.5, h + 0.35);
        ctx.strokeStyle = C.noAmmo;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(sx, sy, 0.3 * cam.scale * 0.707, 0.3 * cam.scale * 0.354, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
  }
}

function drawEnemy(ctx: CanvasRenderingContext2D, cam: Camera, x: number, y: number, _e: Enemy): void {
  const s = cam.scale;
  const [gx, gy] = cam.project(x, y, 0);
  ctx.fillStyle = C.shadow;
  ctx.beginPath();
  ctx.ellipse(gx, gy, s * 0.17, s * 0.085, 0, 0, Math.PI * 2);
  ctx.fill();
  const [bx, by] = cam.project(x, y, 0.32);
  const r = s * 0.15;
  ctx.fillStyle = C.enemy;
  ctx.beginPath();
  ctx.arc(bx, by, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = C.enemyLight;
  ctx.beginPath();
  ctx.arc(bx - r * 0.35, by - r * 0.35, r * 0.35, 0, Math.PI * 2);
  ctx.fill();
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
    const top = (HEIGHT[t.b] ?? 0) + (t.b === Building.Turret ? 0.35 : 0);
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

function quad(ctx: CanvasRenderingContext2D, cam: Camera, pts: P3[], color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  pts.forEach(([x, y, z], i) => {
    const [sx, sy] = cam.project(x, y, z);
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  });
  ctx.closePath();
  ctx.fill();
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
  quad(ctx, cam, [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], shade(base, 0.62));
  quad(ctx, cam, [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], shade(base, 0.8));
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
  ctx.fillStyle = shade(base, 0.7);
  ctx.beginPath();
  ctx.ellipse(bx, by, rx, ry, 0, 0, Math.PI);
  ctx.lineTo(tx - rx, ty);
  ctx.ellipse(tx, ty, rx, ry, 0, Math.PI, 0, true);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = base;
  ctx.beginPath();
  ctx.ellipse(tx, ty, rx, ry, 0, 0, Math.PI * 2);
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
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * Math.max(0, Math.min(1, f)), h);
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
