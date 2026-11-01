// Read-only view of the world. Never mutates simulation state.

import { BUILDINGS, Building, TURRET } from './sim/defs';
import type { World } from './sim/world';

export interface Camera {
  tile: number; // px per tile (CSS px)
  ox: number; // CSS px offset of grid origin
  oy: number;
}

export interface UiState {
  tool: Tool;
  hoverX: number;
  hoverY: number;
}

export type Tool = 'wall' | 'turret' | 'remove';

const C = {
  bg: '#0f1115',
  grid: '#1a1e26',
  spawn: '#2a1518',
  core: '#4fb3ff',
  wall: '#6b7280',
  turret: '#e0b341',
  enemy: '#e5484d',
  shot: '#ffe8a3',
  hpBg: '#00000099',
  hpFg: '#46d37a',
  text: '#d7dae0',
  dim: '#8b93a1',
  ok: '#46d37a55',
  bad: '#e5484d55',
};

export function fitCamera(world: World, cssW: number, cssH: number): Camera {
  const hudH = 36;
  const tile = Math.floor(Math.min(cssW / world.grid.w, (cssH - hudH) / world.grid.h));
  return {
    tile,
    ox: Math.floor((cssW - tile * world.grid.w) / 2),
    oy: hudH + Math.floor((cssH - hudH - tile * world.grid.h) / 2),
  };
}

export function render(
  ctx: CanvasRenderingContext2D,
  world: World,
  cam: Camera,
  ui: UiState,
  alpha: number,
  cssW: number,
  cssH: number,
): void {
  const { grid } = world;
  const T = cam.tile;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, cssW, cssH);

  ctx.save();
  ctx.translate(cam.ox, cam.oy);

  // Floor + spawn column
  ctx.fillStyle = C.spawn;
  ctx.fillRect(0, 0, T, grid.h * T);
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= grid.w; x++) {
    ctx.moveTo(x * T + 0.5, 0);
    ctx.lineTo(x * T + 0.5, grid.h * T);
  }
  for (let y = 0; y <= grid.h; y++) {
    ctx.moveTo(0, y * T + 0.5);
    ctx.lineTo(grid.w * T, y * T + 0.5);
  }
  ctx.stroke();

  // Buildings
  for (let i = 0; i < grid.building.length; i++) {
    const b = grid.building[i];
    if (b === Building.None) continue;
    const x = (i % grid.w) * T;
    const y = ((i / grid.w) | 0) * T;
    const pad = Math.max(1, T * 0.08);
    if (b === Building.Core) {
      ctx.fillStyle = C.core;
      ctx.fillRect(x + pad, y + pad, T - pad * 2, T - pad * 2);
    } else if (b === Building.Wall) {
      ctx.fillStyle = C.wall;
      ctx.fillRect(x + pad, y + pad, T - pad * 2, T - pad * 2);
    } else if (b === Building.Turret) {
      ctx.fillStyle = C.turret;
      ctx.beginPath();
      ctx.arc(x + T / 2, y + T / 2, T * 0.36, 0, Math.PI * 2);
      ctx.fill();
    }
    const max = BUILDINGS[b as Exclude<Building, 0>].hp;
    if (grid.hp[i] < max) hpBar(ctx, x, y - 4, T, grid.hp[i] / max);
  }

  // Enemies (interpolated between ticks)
  ctx.fillStyle = C.enemy;
  for (const e of world.enemies) {
    const ex = (e.prevX + (e.x - e.prevX) * alpha) * T;
    const ey = (e.prevY + (e.y - e.prevY) * alpha) * T;
    ctx.beginPath();
    ctx.arc(ex, ey, T * 0.25, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const e of world.enemies) {
    if (e.hp >= e.maxHp) continue;
    const ex = (e.prevX + (e.x - e.prevX) * alpha) * T;
    const ey = (e.prevY + (e.y - e.prevY) * alpha) * T;
    hpBar(ctx, ex - T * 0.3, ey - T * 0.42, T * 0.6, e.hp / e.maxHp);
  }

  // Shots
  ctx.strokeStyle = C.shot;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const s of world.shots) {
    ctx.moveTo(s.fromX * T, s.fromY * T);
    ctx.lineTo(s.toX * T, s.toY * T);
  }
  ctx.stroke();

  // Placement preview
  if (world.phase === 'build' && grid.inBounds(ui.hoverX, ui.hoverY)) {
    const x = ui.hoverX * T;
    const y = ui.hoverY * T;
    const i = grid.idx(ui.hoverX, ui.hoverY);
    const ok =
      ui.tool === 'remove'
        ? grid.building[i] !== Building.None && grid.building[i] !== Building.Core
        : world.canPlace(ui.hoverX, ui.hoverY);
    ctx.fillStyle = ok ? C.ok : C.bad;
    ctx.fillRect(x, y, T, T);
    if (ui.tool === 'turret') {
      ctx.strokeStyle = C.dim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x + T / 2, y + T / 2, TURRET.range * T, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.restore();
  drawHud(ctx, world, ui, cssW);
}

function hpBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, f: number): void {
  ctx.fillStyle = C.hpBg;
  ctx.fillRect(x, y, w, 3);
  ctx.fillStyle = C.hpFg;
  ctx.fillRect(x, y, w * Math.max(0, f), 3);
}

function drawHud(ctx: CanvasRenderingContext2D, world: World, ui: UiState, cssW: number): void {
  ctx.font = '14px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = C.text;
  const core = Math.max(0, Math.ceil(world.coreHp));
  ctx.fillText(
    `Oleada ${world.wave}   $${world.money}   Núcleo ${core}   Enemigos ${world.enemies.length}`,
    12,
    18,
  );
  if (world.phase === 'lost') {
    ctx.fillStyle = C.enemy;
    ctx.fillText('DERROTA', cssW - 90, 18);
  } else if (world.phase === 'wave') {
    ctx.fillStyle = C.dim;
    ctx.fillText('en curso…', cssW - 100, 18);
  }
  void ui;
}
