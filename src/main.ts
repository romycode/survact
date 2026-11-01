import { Camera } from './camera';
import { attachInput } from './input';
import { NO_HOVER, TOOL_BUILDING, isDirected, render, type Tool, type UiState } from './render';
import { BUILDINGS, Building, Item, costEntries } from './sim/defs';
import { key } from './sim/grid';
import { DT, World, type Command } from './sim/world';

const SPEEDS = [1, 2, 3];

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const ctx = canvas.getContext('2d')!;
const host = canvas.parentElement!;

let world = newWorld();
const cam = new Camera();
const ui: UiState = { tool: 'belt', hoverX: NO_HOVER, hoverY: NO_HOVER, speed: 1, dir: 0, sel: null };
let cssW = 0;
let cssH = 0;
let dpr = 1;

// Commands are queued from input and applied at the start of the next tick,
// so input never mutates the world mid-tick.
const pending: Command[] = [];

function newWorld(): World {
  return new World((Math.random() * 2 ** 32) >>> 0);
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
  cam.resize(cssW, cssH);
}
new ResizeObserver(resize).observe(host);
resize();

attachInput({
  canvas,
  cam,
  ui,
  emit: (cmd) => pending.push(cmd),
  buildingAt: (x, y) => world.grid.building(key(x, y)),
  isDirected: (x, y) => isDirected(world, x, y),
});

// ---------- Keyboard + on-screen buttons share one handler ----------
const TOOL_KEYS: Record<string, Tool> = {
  Digit1: 'belt',
  Digit2: 'miner',
  Digit3: 'furnace',
  Digit4: 'turret',
  Digit5: 'wall',
  KeyX: 'remove',
};

function handleKey(code: string): boolean {
  if (code in TOOL_KEYS) {
    ui.tool = TOOL_KEYS[code];
    return true;
  }
  switch (code) {
    case 'Space':
      pending.push({ type: 'startWave' });
      break;
    case 'KeyE': {
      // Rotate the selected piece if there is one; the next piece follows it.
      const sel = ui.sel;
      const t = sel ? world.grid.get(key(sel[0], sel[1])) : undefined;
      if (sel && t && BUILDINGS[t.b].directed) {
        const d = (t.dir + 1) & 3;
        pending.push({ type: 'rotate', x: sel[0], y: sel[1], dir: d });
        ui.dir = d;
      } else {
        ui.dir = (ui.dir + 1) & 3;
      }
      break;
    }
    case 'KeyF':
      ui.speed = SPEEDS[(SPEEDS.indexOf(ui.speed) + 1) % SPEEDS.length];
      break;
    case 'KeyC':
      cam.centerOn(0.5, 0.5);
      break;
    case 'KeyR':
      if (world.phase === 'lost') {
        world = newWorld();
        pending.length = 0;
        ui.speed = 1;
        ui.sel = null;
        cam.centerOn(0.5, 0.5);
      }
      break;
    case 'KeyW':
      cam.panBy(0, 60);
      break;
    case 'KeyS':
      cam.panBy(0, -60);
      break;
    case 'KeyA':
      cam.panBy(60, 0);
      break;
    case 'KeyD':
      cam.panBy(-60, 0);
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
  iron: $('hud-iron'),
  plate: $('hud-plate'),
  core: $('hud-core'),
  coreText: $('hud-core-text'),
  enemies: $('hud-enemies'),
  speed: $('hud-speed'),
  dir: $('hud-dir'),
};
const coreMax = BUILDINGS[Building.Core].hp;
// World dir -> arrow as seen on screen in the iso view (+x down-right, +y down-left).
const ARROWS = ['↘', '↙', '↖', '↗'];

let lastSig = '';
function syncHud(): void {
  const core = Math.max(0, Math.ceil(world.coreHp));
  const enemies =
    world.phase === 'build' ? `Siguiente: ${world.nextWaveSize}` : `Quedan: ${world.remaining}`;
  const iron = world.inv[Item.Iron];
  const plate = world.inv[Item.Plate];
  const sig = [world.wave, iron, plate, core, enemies, ui.tool, ui.speed, ui.dir, world.phase].join('|');
  if (sig === lastSig) return;
  lastSig = sig;

  if (hud.wave) hud.wave.textContent = String(world.wave);
  if (hud.iron) hud.iron.textContent = String(iron);
  if (hud.plate) hud.plate.textContent = String(plate);
  if (hud.core) hud.core.style.width = `${(core / coreMax) * 100}%`;
  if (hud.coreText) hud.coreText.textContent = String(core);
  if (hud.enemies) hud.enemies.textContent = enemies;
  if (hud.speed) hud.speed.textContent = `x${ui.speed}`;
  if (hud.dir) hud.dir.textContent = ARROWS[ui.dir];

  for (const b of buttons) {
    const k = b.dataset.key!;
    const tool = TOOL_KEYS[k];
    if (tool) {
      b.setAttribute('aria-pressed', String(tool === ui.tool));
      if (tool !== 'remove') b.classList.toggle('poor', !world.canAfford(BUILDINGS[TOOL_BUILDING[tool]].cost));
    }
    if (k === 'Space') b.hidden = world.phase !== 'build';
    if (k === 'KeyR') b.hidden = world.phase !== 'lost';
  }
  document.body.dataset.phase = world.phase;
}

// Cost labels come from the data, so the buttons can't drift from the balance.
for (const b of buttons) {
  const tool = TOOL_KEYS[b.dataset.key!];
  const label = b.querySelector('small');
  if (!tool || tool === 'remove' || !label) continue;
  label.textContent = costEntries(BUILDINGS[TOOL_BUILDING[tool]].cost)
    .map(([r, n]) => `${n} ${r === Item.Iron ? 'Fe' : 'pl'}`)
    .join(' ');
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
