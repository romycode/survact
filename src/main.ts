import { Camera } from './camera';
import { Hud, TOOL_KEYS } from './hud';
import { Inspector } from './inspector';
import { attachInput } from './input';
import { Plans } from './plans';
import { NO_HOVER, prof, render, terrainCache, type UiState } from './render';
import { BUILDINGS } from './sim/defs';
import { key } from './sim/grid';
import { DT, World, type Command } from './sim/world';

const SPEEDS = [1, 2, 3];
let paused = false;

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const ctx = canvas.getContext('2d')!;
const host = canvas.parentElement!;

let world = newWorld();
const cam = new Camera();
const plans = new Plans();
const ui: UiState = {
  tool: 'select',
  hoverX: NO_HOVER,
  hoverY: NO_HOVER,
  speed: 1,
  dir: 0,
  sel: null,
  plans,
  planEval: null,
};

function commitPlans(): void {
  for (const cmd of plans.commit(world)) pending.push(cmd);
}
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

const inspector = new Inspector(canvas, host, (act) => {
  if (act === 'rotate') handleKey('KeyE');
  else if (act === 'close') ui.sel = null;
  else if (act === 'remove' && ui.sel) {
    pending.push({ type: 'remove', x: ui.sel[0], y: ui.sel[1] });
    ui.sel = null;
  }
});
document.body.dataset.htmlInCanvas = inspector.mode === 'canvas' ? 'on' : 'off';

attachInput({
  canvas,
  cam,
  ui,
  emit: (cmd) => pending.push(cmd),
  plans,
  buildingAt: (x, y) => world.grid.building(key(x, y)),
  dirAt: (x, y) => world.grid.get(key(x, y))?.dir ?? ui.dir,
  phase: () => world.phase,
  commit: commitPlans,
});

// ---------- Keyboard + on-screen buttons share one handler ----------
function handleKey(code: string): boolean {
  if (code in TOOL_KEYS) {
    // Tapping the active tool again puts it away (back to moving the camera).
    const t = TOOL_KEYS[code];
    ui.tool = ui.tool === t ? 'select' : t;
    return true;
  }
  switch (code) {
    case 'Space':
      pending.push({ type: 'startWave' });
      break;
    case 'KeyP':
      paused = !paused;
      break;
    case 'Enter':
      commitPlans();
      break;
    case 'Escape':
      if (plans.size > 0) plans.clear();
      else ui.sel = null;
      break;
    case 'KeyE': {
      // Rotate the selected piece if there is one; the next piece follows it.
      const sel = ui.sel;
      const t = sel ? world.grid.get(key(sel[0], sel[1])) : undefined;
      const lastPlan = [...plans.map.values()].at(-1);
      if (sel && t && BUILDINGS[t.b].directed) {
        const d = (t.dir + 1) & 3;
        pending.push({ type: 'rotate', x: sel[0], y: sel[1], dir: d });
        ui.dir = d;
      } else if (lastPlan && lastPlan.kind !== 'remove' && (lastPlan.kind === 'rotate' || BUILDINGS[lastPlan.b].directed)) {
        lastPlan.dir = (lastPlan.dir + 1) & 3;
        ui.dir = lastPlan.dir;
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
        paused = false;
        ui.sel = null;
        plans.clear();
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

for (const b of document.querySelectorAll<HTMLElement>('[data-key]')) {
  b.addEventListener('click', () => handleKey(b.dataset.key!));
}

const hud = new Hud(ui, plans);

// ---------- Fixed-timestep loop ----------
let acc = 0;
let last = performance.now();

function frame(now: number): void {
  const speed = paused ? 0 : ui.speed;
  acc += Math.min((now - last) / 1000, 0.25) * speed;
  last = now;
  while (acc >= DT) {
    for (const cmd of pending) world.apply(cmd);
    pending.length = 0;
    world.tick();
    acc -= DT;
  }
  if (ui.sel && !world.grid.get(key(ui.sel[0], ui.sel[1]))) ui.sel = null; // destroyed/removed
  if (world.phase === 'lost' && plans.size > 0) plans.clear();
  ui.planEval = plans.size > 0 ? plans.evaluate(world) : null;
  render(ctx, world, cam, ui, acc / DT, dpr, cssW, cssH);
  inspector.update(world, cam, ui);
  inspector.draw(ctx, dpr, cssW, cssH);
  hud.sync(world, paused);
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
  inspector,
  /** Average ms per render() over n frames, for profiling. */
  benchRender(n = 60): { total: number; phases: Record<string, number>; chunks: unknown } {
    prof.on = true;
    prof.ms = {};
    const t0 = performance.now();
    for (let i = 0; i < n; i++) render(ctx, world, cam, ui, 0, dpr, cssW, cssH);
    const total = (performance.now() - t0) / n;
    prof.on = false;
    const phases: Record<string, number> = {};
    for (const [k, v] of Object.entries(prof.ms)) phases[k] = Math.round((v / n) * 100) / 100;
    return { total: Math.round(total * 100) / 100, phases, chunks: terrainCache.stats };
  },
};
