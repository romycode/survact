import { Camera } from './camera';
import { attachInput } from './input';
import { isDirected, render, type UiState } from './render';
import { BUILDINGS, Building } from './sim/defs';
import { DT, World, type Command } from './sim/world';

const GRID_W = 28;
const GRID_H = 16;
const SPEEDS = [1, 2, 3];

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const ctx = canvas.getContext('2d')!;
const host = canvas.parentElement!;

let world = newWorld();
const cam = new Camera();
const ui: UiState = { tool: 'belt', hoverX: -1, hoverY: -1, speed: 1, dir: 0, sel: null };
let cssW = 0;
let cssH = 0;
let dpr = 1;

// Commands are queued from input and applied at the start of the next tick,
// so input never mutates the world mid-tick.
const pending: Command[] = [];

function newWorld(): World {
  const seed = (Math.random() * 2 ** 32) >>> 0;
  return new World(GRID_W, GRID_H, seed);
}

// ---------- HiDPI resize (fits the canvas's parent, not the window) ----------
function resize(): void {
  dpr = window.devicePixelRatio || 1;
  cssW = host.clientWidth;
  cssH = host.clientHeight;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  cam.resize(cssW, cssH, GRID_W, GRID_H);
}
new ResizeObserver(resize).observe(host);
resize();

attachInput({
  canvas,
  cam,
  ui,
  emit: (cmd) => pending.push(cmd),
  buildingAt: (x, y) => (world.grid.inBounds(x, y) ? world.grid.building[world.grid.idx(x, y)] : -1),
  isDirected: (x, y) => isDirected(world, x, y),
});

// ---------- Keyboard + on-screen buttons share one handler ----------
function handleKey(code: string): boolean {
  switch (code) {
    case 'Digit1':
      ui.tool = 'wall';
      break;
    case 'Digit2':
      ui.tool = 'turret';
      break;
    case 'Digit3':
      ui.tool = 'belt';
      break;
    case 'Digit4':
      ui.tool = 'miner';
      break;
    case 'KeyX':
      ui.tool = 'remove';
      break;
    case 'KeyE': {
      // Rotate the selected piece if there is one; the next piece follows it.
      const sel = ui.sel;
      if (sel && isDirected(world, sel[0], sel[1])) {
        const d = (world.grid.dir[world.grid.idx(sel[0], sel[1])] + 1) & 3;
        pending.push({ type: 'rotate', x: sel[0], y: sel[1], dir: d });
        ui.dir = d;
      } else {
        ui.dir = (ui.dir + 1) & 3;
      }
      break;
    }
    case 'Space':
      pending.push({ type: 'startWave' });
      break;
    case 'KeyF':
      ui.speed = SPEEDS[(SPEEDS.indexOf(ui.speed) + 1) % SPEEDS.length];
      break;
    case 'KeyR':
      if (world.phase === 'lost') {
        world = newWorld();
        pending.length = 0;
        ui.speed = 1;
        ui.sel = null;
      }
      break;
    case 'KeyW':
      cam.panBy(0, 40);
      break;
    case 'KeyS':
      cam.panBy(0, -40);
      break;
    case 'KeyA':
      cam.panBy(40, 0);
      break;
    case 'KeyD':
      cam.panBy(-40, 0);
      break;
    default:
      return false;
  }
  return true;
}

window.addEventListener('keydown', (e) => {
  if (handleKey(e.code)) e.preventDefault();
});

const buttons = [...document.querySelectorAll<HTMLElement>('[data-key]')];
for (const b of buttons) b.addEventListener('click', () => handleKey(b.dataset.key!));

// ---------- DOM HUD: only touched when a value changes ----------
const $ = (id: string) => document.getElementById(id);
const hud = {
  wave: $('hud-wave'),
  money: $('hud-money'),
  core: $('hud-core'),
  coreText: $('hud-core-text'),
  enemies: $('hud-enemies'),
  speed: $('hud-speed'),
  dir: $('hud-dir'),
};
const coreMax = BUILDINGS[Building.Core].hp;
const costOf: Record<string, number> = {
  Digit1: BUILDINGS[Building.Wall].cost,
  Digit2: BUILDINGS[Building.Turret].cost,
  Digit3: BUILDINGS[Building.Belt].cost,
  Digit4: BUILDINGS[Building.Miner].cost,
};
const toolOf: Record<string, UiState['tool']> = {
  Digit1: 'wall',
  Digit2: 'turret',
  Digit3: 'belt',
  Digit4: 'miner',
  KeyX: 'remove',
};
// Sim dir -> arrow as seen on screen (portrait transposes the grid: E<->S, W<->N).
const ARROWS = ['→', '↓', '←', '↑'];
const screenArrow = (d: number): string => ARROWS[cam.rot ? [1, 0, 3, 2][d] : d];

let lastSig = '';
function syncHud(): void {
  const core = Math.max(0, Math.ceil(world.coreHp));
  const enemies =
    world.phase === 'build' ? `Siguiente: ${world.nextWaveSize}` : `Quedan: ${world.remaining}`;
  const sig = [world.wave, world.money, core, enemies, ui.tool, ui.speed, ui.dir, cam.rot, world.phase].join('|');
  if (sig === lastSig) return;
  lastSig = sig;

  if (hud.wave) hud.wave.textContent = String(world.wave);
  if (hud.money) hud.money.textContent = String(world.money);
  if (hud.core) hud.core.style.width = `${(core / coreMax) * 100}%`;
  if (hud.coreText) hud.coreText.textContent = String(core);
  if (hud.enemies) hud.enemies.textContent = enemies;
  if (hud.speed) hud.speed.textContent = `x${ui.speed}`;
  if (hud.dir) hud.dir.textContent = screenArrow(ui.dir);

  for (const b of buttons) {
    const k = b.dataset.key!;
    if (k in toolOf) b.setAttribute('aria-pressed', String(toolOf[k] === ui.tool));
    if (k in costOf) b.classList.toggle('poor', world.money < costOf[k]);
    if (k === 'Space') b.hidden = world.phase !== 'build';
    if (k === 'KeyR') b.hidden = world.phase !== 'lost';
  }
  document.body.dataset.phase = world.phase;
}

// ---------- Fixed-timestep loop ----------
let acc = 0;
let last = performance.now();

function frame(now: number): void {
  const speed = world.phase === 'wave' ? ui.speed : 1;
  acc += Math.min((now - last) / 1000, 0.25) * speed;
  last = now;
  while (acc >= DT) {
    for (const cmd of pending) world.apply(cmd);
    pending.length = 0;
    world.tick();
    acc -= DT;
  }
  render(ctx, world, cam, ui, acc / DT, dpr, cssW, cssH);
  syncHud();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Debug handle for the console / automated tests. Read-only by convention.
(globalThis as unknown as { __survact: unknown }).__survact = {
  get world() {
    return world;
  },
  cam,
  ui,
};
