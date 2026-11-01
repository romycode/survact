// Read-only view of the world. Never mutates simulation state
// (world.syncFlow() only refreshes a derived cache).

import type { Camera } from './camera';
import { BELT, BUILDINGS, Building, DIR_X, DIR_Y, TURRET, type Placeable } from './sim/defs';
import { NO_NEXT } from './sim/flowfield';
import type { World } from './sim/world';

export type Tool = 'wall' | 'turret' | 'belt' | 'miner' | 'remove';

export const TOOL_BUILDING: Record<Exclude<Tool, 'remove'>, Placeable> = {
  wall: Building.Wall,
  turret: Building.Turret,
  belt: Building.Belt,
  miner: Building.Miner,
};

export interface UiState {
  tool: Tool;
  hoverX: number;
  hoverY: number;
  speed: number;
  /** Facing for new directed buildings, 0=E 1=S 2=W 3=N (sim space). */
  dir: number;
}

const C = {
  bg: '#0f1115',
  floor: '#13161d',
  grid: '#1d222c',
  spawn: '#2a1518',
  ore: '#8a5a3c',
  belt: '#252b36',
  beltMark: '#3d4656',
  miner: '#9c6b4a',
  item: '#d98a52',
  noAmmo: '#e5484d',
  path: '#e5484d55',
  core: '#4fb3ff',
  wall: '#6b7280',
  turret: '#e0b341',
  enemy: '#e5484d',
  shot: '#ffe8a3',
  hpBg: '#000000aa',
  hpFg: '#46d37a',
  range: '#e0b34155',
  ok: '#46d37a55',
  bad: '#e5484d55',
};

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
  const { grid } = world;
  const px = 1 / cam.scale; // one CSS pixel in tile units

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, cssW, cssH);

  // ---- Sim-space pass (tile units, transposed on portrait) ----
  ctx.save();
  cam.applySim(ctx);

  ctx.fillStyle = C.floor;
  ctx.fillRect(0, 0, grid.w, grid.h);
  ctx.fillStyle = C.spawn;
  ctx.fillRect(0, 0, 1, grid.h);

  ctx.strokeStyle = C.grid;
  ctx.lineWidth = px;
  ctx.beginPath();
  for (let x = 0; x <= grid.w; x++) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, grid.h);
  }
  for (let y = 0; y <= grid.h; y++) {
    ctx.moveTo(0, y);
    ctx.lineTo(grid.w, y);
  }
  ctx.stroke();

  drawOre(ctx, world);
  drawBelts(ctx, world);
  if (world.phase === 'build') drawPaths(ctx, world);

  const pad = 0.08;
  for (let i = 0; i < grid.building.length; i++) {
    const b = grid.building[i];
    if (b === Building.None) continue;
    const x = i % grid.w;
    const y = (i / grid.w) | 0;
    if (b === Building.Belt) continue; // drawn in drawBelts
    if (b === Building.Turret) {
      const empty = grid.ammo[i] === 0;
      ctx.globalAlpha = empty ? 0.45 : 1;
      ctx.fillStyle = C.turret;
      ctx.beginPath();
      ctx.arc(x + 0.5, y + 0.5, 0.36, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (empty) {
        ctx.strokeStyle = C.noAmmo;
        ctx.lineWidth = 2 * px;
        ctx.beginPath();
        ctx.arc(x + 0.5, y + 0.5, 0.42, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else if (b === Building.Miner) {
      ctx.fillStyle = C.miner;
      ctx.fillRect(x + pad, y + pad, 1 - pad * 2, 1 - pad * 2);
      arrow(ctx, x + 0.5, y + 0.5, grid.dir[i], 0.3, C.bg);
    } else {
      ctx.fillStyle = b === Building.Core ? C.core : C.wall;
      ctx.fillRect(x + pad, y + pad, 1 - pad * 2, 1 - pad * 2);
    }
  }

  ctx.fillStyle = C.enemy;
  for (const e of world.enemies) {
    ctx.beginPath();
    ctx.arc(lerp(e.prevX, e.x, alpha), lerp(e.prevY, e.y, alpha), 0.26, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = C.shot;
  ctx.lineWidth = 2 * px;
  ctx.beginPath();
  for (const s of world.shots) {
    ctx.moveTo(s.fromX, s.fromY);
    ctx.lineTo(s.toX, s.toY);
  }
  ctx.stroke();

  if (world.phase === 'build' && grid.inBounds(ui.hoverX, ui.hoverY)) {
    const i = grid.idx(ui.hoverX, ui.hoverY);
    const ok =
      ui.tool === 'remove'
        ? grid.building[i] !== Building.None && grid.building[i] !== Building.Core
        : world.canPlace(ui.hoverX, ui.hoverY, TOOL_BUILDING[ui.tool]);
    ctx.fillStyle = ok ? C.ok : C.bad;
    ctx.fillRect(ui.hoverX, ui.hoverY, 1, 1);
    if (ui.tool === 'belt' || ui.tool === 'miner') {
      arrow(ctx, ui.hoverX + 0.5, ui.hoverY + 0.5, ui.dir, 0.3, C.shot);
    }
    if (ui.tool === 'turret') {
      ctx.strokeStyle = C.range;
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      ctx.arc(ui.hoverX + 0.5, ui.hoverY + 0.5, TURRET.range, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();

  // ---- View-space pass: HP bars stay horizontal whatever the rotation ----
  ctx.save();
  cam.applyView(ctx);
  const barH = 3 * px;
  for (let i = 0; i < grid.building.length; i++) {
    const b = grid.building[i];
    if (b === Building.None) continue;
    const max = BUILDINGS[b as Exclude<Building, 0>].hp;
    if (grid.hp[i] >= max) continue;
    const [u, v] = cam.simToView(i % grid.w, (i / grid.w) | 0);
    hpBar(ctx, u + 0.1, v + 0.02, 0.8, barH, grid.hp[i] / max);
  }
  for (let i = 0; i < grid.building.length; i++) {
    if (grid.building[i] !== Building.Turret || grid.ammo[i] === 0) continue;
    const [u, v] = cam.simToView(i % grid.w, (i / grid.w) | 0);
    bar(ctx, u + 0.1, v + 0.94, 0.8, barH, grid.ammo[i] / TURRET.maxAmmo, C.turret);
  }
  for (const e of world.enemies) {
    if (e.hp >= e.maxHp) continue;
    const [u, v] = cam.simToView(lerp(e.prevX, e.x, alpha), lerp(e.prevY, e.y, alpha));
    hpBar(ctx, u - 0.3, v - 0.42, 0.6, barH, e.hp / e.maxHp);
  }
  ctx.restore();
}

/** Trace the route from every spawn row so the player sees how walls bend it. */
function drawPaths(ctx: CanvasRenderingContext2D, world: World): void {
  world.syncFlow();
  const { grid, flow } = world;
  const seen = new Uint8Array(grid.w * grid.h);
  for (let y = 0; y < grid.h; y++) {
    let t = grid.idx(0, y);
    for (let guard = 0; t !== NO_NEXT && guard < seen.length; guard++) {
      if (seen[t]) break;
      seen[t] = 1;
      t = flow.next[t];
    }
  }
  ctx.fillStyle = C.path;
  ctx.beginPath();
  for (let i = 0; i < seen.length; i++) {
    if (!seen[i] || grid.building[i] === Building.Core) continue;
    const x = (i % grid.w) + 0.5;
    const y = ((i / grid.w) | 0) + 0.5;
    ctx.moveTo(x + 0.1, y);
    ctx.arc(x, y, 0.1, 0, Math.PI * 2);
  }
  ctx.fill();
}

function hpBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, f: number): void {
  bar(ctx, x, y, w, h, f, C.hpFg);
}

function bar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  f: number,
  color: string,
): void {
  ctx.fillStyle = C.hpBg;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * Math.max(0, Math.min(1, f)), h);
}

/** Chevron pointing in sim direction d, centred at (cx, cy). */
function arrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, d: number, size: number, color: string): void {
  const fx = DIR_X[d];
  const fy = DIR_Y[d];
  // perpendicular
  const px = -fy;
  const py = fx;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx + fx * size, cy + fy * size);
  ctx.lineTo(cx - fx * size * 0.6 + px * size * 0.8, cy - fy * size * 0.6 + py * size * 0.8);
  ctx.lineTo(cx - fx * size * 0.2, cy - fy * size * 0.2);
  ctx.lineTo(cx - fx * size * 0.6 - px * size * 0.8, cy - fy * size * 0.6 - py * size * 0.8);
  ctx.closePath();
  ctx.fill();
}

function drawOre(ctx: CanvasRenderingContext2D, world: World): void {
  const { grid } = world;
  ctx.fillStyle = C.ore;
  ctx.beginPath();
  for (let i = 0; i < grid.ore.length; i++) {
    if (!grid.ore[i]) continue;
    const x = i % grid.w;
    const y = (i / grid.w) | 0;
    // Fixed pseudo-random speckle per tile so it reads as terrain, not as a building.
    for (let k = 0; k < 4; k++) {
      const h = ((i * 73856093) ^ (k * 19349663)) >>> 0;
      const ox = 0.2 + ((h & 255) / 255) * 0.6;
      const oy = 0.2 + (((h >> 8) & 255) / 255) * 0.6;
      ctx.moveTo(x + ox + 0.09, y + oy);
      ctx.arc(x + ox, y + oy, 0.09, 0, Math.PI * 2);
    }
  }
  ctx.fill();
}

function drawBelts(ctx: CanvasRenderingContext2D, world: World): void {
  const { grid } = world;
  const phase = (world.tickCount % BELT.ticksPerTile) / BELT.ticksPerTile;
  for (let i = 0; i < grid.building.length; i++) {
    if (grid.building[i] !== Building.Belt) continue;
    const x = i % grid.w;
    const y = (i / grid.w) | 0;
    const d = grid.dir[i];
    ctx.fillStyle = C.belt;
    ctx.fillRect(x + 0.12, y + 0.12, 0.76, 0.76);
    // Two moving chevrons give direction and motion at a glance.
    const moving = world.phase === 'wave' ? phase : 0;
    for (let k = 0; k < 2; k++) {
      const t = ((k * 0.5 + moving) % 1) - 0.5;
      arrow(ctx, x + 0.5 + DIR_X[d] * t * 0.7, y + 0.5 + DIR_Y[d] * t * 0.7, d, 0.14, C.beltMark);
    }
  }
  ctx.fillStyle = C.item;
  for (let i = 0; i < grid.building.length; i++) {
    if (grid.building[i] !== Building.Belt || !grid.item[i]) continue;
    const d = grid.dir[i];
    const t = grid.itemProg[i] / BELT.ticksPerTile - 0.5; // -0.5 back edge .. 0.5 front edge
    const cx = (i % grid.w) + 0.5 + DIR_X[d] * t;
    const cy = ((i / grid.w) | 0) + 0.5 + DIR_Y[d] * t;
    ctx.fillRect(cx - 0.14, cy - 0.14, 0.28, 0.28);
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
