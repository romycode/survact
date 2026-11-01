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

// ---------- HiDPI resize (fits the canvas's parent, not the window) ----------
const host = canvas.parentElement!;
function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  cssW = host.clientWidth;
  cssH = host.clientHeight;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cam = fitCamera(world, cssW, cssH);
}
new ResizeObserver(resize).observe(host);
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

function handleKey(code: string): boolean {
  switch (code) {
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
      pending.push({ type: 'startWave' });
      break;
    case 'KeyR':
      if (world.phase === 'lost') {
        world = newWorld();
        pending.length = 0;
      }
      break;
    default:
      return false;
  }
  return true;
}

window.addEventListener('keydown', (e) => {
  if (handleKey(e.code)) e.preventDefault();
});

// Optional on-screen controls (touch): any element with data-key="<KeyboardEvent.code>".
const buttons = [...document.querySelectorAll<HTMLElement>('[data-key]')];
for (const b of buttons) b.addEventListener('click', () => handleKey(b.dataset.key!));

let lastUiSig = '';
function syncButtons(): void {
  const sig = `${ui.tool}|${world.phase}`;
  if (sig === lastUiSig) return;
  lastUiSig = sig;
  const toolOf: Record<string, string> = { Digit1: 'wall', Digit2: 'turret', KeyX: 'remove' };
  for (const b of buttons) {
    const k = b.dataset.key!;
    if (k in toolOf) b.setAttribute('aria-pressed', String(toolOf[k] === ui.tool));
    if (k === 'Space') b.hidden = world.phase !== 'build';
    if (k === 'KeyR') b.hidden = world.phase !== 'lost';
  }
}

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
  syncButtons();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
