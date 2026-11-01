// Read-only view of the world. Never mutates simulation state
// (world.syncFlow() only refreshes a derived cache).

import type { Camera } from './camera';
import { BUILDINGS, Building, TURRET } from './sim/defs';
import { NO_NEXT } from './sim/flowfield';
import type { World } from './sim/world';

export type Tool = 'wall' | 'turret' | 'remove';

export interface UiState {
  tool: Tool;
  hoverX: number;
  hoverY: number;
  speed: number;
}

const C = {
  bg: '#0f1115',
  floor: '#13161d',
  grid: '#1d222c',
  spawn: '#2a1518',
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

  if (world.phase === 'build') drawPaths(ctx, world);

  const pad = 0.08;
  for (let i = 0; i < grid.building.length; i++) {
    const b = grid.building[i];
    if (b === Building.None) continue;
    const x = i % grid.w;
    const y = (i / grid.w) | 0;
    if (b === Building.Turret) {
      ctx.fillStyle = C.turret;
      ctx.beginPath();
      ctx.arc(x + 0.5, y + 0.5, 0.36, 0, Math.PI * 2);
      ctx.fill();
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
        : world.canPlace(ui.hoverX, ui.hoverY);
    ctx.fillStyle = ok ? C.ok : C.bad;
    ctx.fillRect(ui.hoverX, ui.hoverY, 1, 1);
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

function hpBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  f: number,
): void {
  ctx.fillStyle = C.hpBg;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = C.hpFg;
  ctx.fillRect(x, y, w * Math.max(0, f), h);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
