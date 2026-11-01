import { fitCamera, render, type Camera, type UiState } from './render';
import { Building } from './sim/defs';
import { DT, World, type Command } from './sim/world';

const GRID_W = 28;
const GRID_H = 16;

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const ctx = canvas.getContext('2d')!;

let world = newWorld();
let cam: Camera = { tile: 32, ox: 0, oy: 0 };
let cssW = 0;
let cssH = 0;
const ui: UiState = { tool: 'wall', hoverX: -1, hoverY: -1 };

// Commands are queued from input and applied at the start of the next tick,
// so input never mutates the world mid-tick.
const pending: Command[] = [];

function newWorld(): World {
  const seed = (Math.random() * 2 ** 32) >>> 0;
  return new World(GRID_W, GRID_H, seed);
}

// ---------- HiDPI resize ----------
function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  cssW = window.innerWidth;
  cssH = window.innerHeight;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cam = fitCamera(world, cssW, cssH);
}
window.addEventListener('resize', resize);
resize();

// ---------- Input ----------
function toTile(clientX: number, clientY: number): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [
    Math.floor((clientX - r.left - cam.ox) / cam.tile),
    Math.floor((clientY - r.top - cam.oy) / cam.tile),
  ];
}

let painting: 'place' | 'remove' | null = null;

function act(x: number, y: number, mode: 'place' | 'remove'): void {
  if (mode === 'remove' || ui.tool === 'remove') {
    pending.push({ type: 'remove', x, y });
  } else {
    pending.push({
      type: 'place',
      x,
      y,
      building: ui.tool === 'wall' ? Building.Wall : Building.Turret,
    });
  }
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  const [x, y] = toTile(e.clientX, e.clientY);
  painting = e.button === 2 ? 'remove' : 'place';
  canvas.setPointerCapture(e.pointerId);
  act(x, y, painting);
});
canvas.addEventListener('pointermove', (e) => {
  const [x, y] = toTile(e.clientX, e.clientY);
  if (x === ui.hoverX && y === ui.hoverY) return;
  ui.hoverX = x;
  ui.hoverY = y;
  if (painting) act(x, y, painting); // drag to paint walls
});
canvas.addEventListener('pointerup', () => (painting = null));
canvas.addEventListener('pointercancel', () => (painting = null));

window.addEventListener('keydown', (e) => {
  switch (e.code) {
    case 'Digit1':
      ui.tool = 'wall';
      break;
    case 'Digit2':
      ui.tool = 'turret';
      break;
    case 'KeyX':
      ui.tool = 'remove';
      break;
    case 'Space':
      e.preventDefault();
      pending.push({ type: 'startWave' });
      break;
    case 'KeyR':
      if (world.phase === 'lost') {
        world = newWorld();
        pending.length = 0;
      }
      break;
  }
});

// ---------- Fixed-timestep loop ----------
let acc = 0;
let last = performance.now();

function frame(now: number): void {
  acc += Math.min((now - last) / 1000, 0.25);
  last = now;
  while (acc >= DT) {
    for (const cmd of pending) world.apply(cmd);
    pending.length = 0;
    world.tick();
    acc -= DT;
  }
  render(ctx, world, cam, ui, acc / DT, cssW, cssH);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
