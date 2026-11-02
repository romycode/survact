// DOM HUD over the map: resource chips, core health, clock, wave countdown,
// the context strip above the dock, tool slots and the game-over card.
// Everything is written only when its value changes.

import type { Plans } from './plans';
import { TOOL_BUILDING, drawToolIcon, type Tool, type UiState } from './render';
import { BELT_TICKS, BUILDINGS, Building, FURNACE, Item, MINER, TURRET, costEntries, type Cost } from './sim/defs';
import { TICK_RATE, type World } from './sim/world';

export const TOOL_KEYS: Record<string, Tool> = {
  KeyQ: 'select',
  Digit1: 'belt',
  Digit2: 'fastbelt',
  Digit3: 'miner',
  Digit4: 'furnace',
  Digit5: 'turret',
  Digit6: 'wall',
  KeyX: 'remove',
};

const DIRECTED_TOOLS: Tool[] = ['belt', 'fastbelt', 'miner', 'furnace'];

const perSec = (ticks: number) => (TICK_RATE / ticks).toLocaleString('es', { maximumFractionDigits: 1 });

/** One line under the tool name: what it does and how to use it on touch. */
const TOOL_INFO: Record<Exclude<Tool, 'select'>, { name: string; desc: string }> = {
  belt: { name: 'Cinta', desc: `${perSec(BELT_TICKS[Building.Belt]!)} tiles/s · arrastra para trazar` },
  fastbelt: { name: 'Cinta rápida', desc: `${perSec(BELT_TICKS[Building.FastBelt]!)} tiles/s · encima de una cinta la mejora` },
  miner: { name: 'Minero', desc: `Sobre hierro · ${perSec(MINER.ticksPerItem)} Fe/s` },
  furnace: { name: 'Horno', desc: `Hierro → placa cada ${(FURNACE.ticksPerPlate / TICK_RATE).toLocaleString('es')} s` },
  turret: { name: 'Torreta', desc: `Alcance ${TURRET.range.toLocaleString('es')} · munición por cinta` },
  wall: { name: 'Muro', desc: 'Desvía o frena enemigos · arrastra para trazar' },
  remove: { name: 'Quitar', desc: 'Toca o arrastra · devuelve el 100%' },
};

// World dir -> arrow as seen on screen in the iso view (+x down-right, +y down-left).
const ARROWS = ['↘', '↙', '↖', '↗'];

export function costText(c: Cost): string {
  return costEntries(c)
    .map(([r, n]) => `${n} ${r === Item.Iron ? 'Fe' : 'pl'}`)
    .join(' ');
}

export class Hud {
  private readonly $ = (id: string) => document.getElementById(id)!;
  private readonly el = {
    iron: this.$('hud-iron'),
    plate: this.$('hud-plate'),
    core: this.$('hud-core'),
    coreChip: document.querySelector<HTMLElement>('.chip.core')!,
    clock: this.$('hud-clock'),
    wave: this.$('hud-wave'),
    waveLabel: this.$('hud-wave-label'),
    waveTime: this.$('hud-wave-time'),
    call: document.querySelector<HTMLElement>('.call')!,
    speed: this.$('hud-speed'),
    dir: this.$('hud-dir'),
    ctx: this.$('ctx'),
    ctxInfo: this.$('ctx-info'),
    ctxName: this.$('ctx-name'),
    ctxDesc: this.$('ctx-desc'),
    ctxRot: this.$('ctx-rot'),
    ctxPlans: this.$('ctx-plans'),
    planCost: this.$('hud-plan-cost'),
    confirm: document.querySelector<HTMLButtonElement>('[data-key="Enter"]')!,
    gameover: this.$('gameover'),
    goStats: this.$('go-stats'),
  };
  private readonly toolButtons = [...document.querySelectorAll<HTMLElement>('[data-key]')].filter(
    (b) => TOOL_KEYS[b.dataset.key!],
  );
  private last = new Map<string, string>();

  private readonly ui: UiState;
  private readonly plans: Plans;

  constructor(ui: UiState, plans: Plans) {
    this.ui = ui;
    this.plans = plans;
    // Costs come from the data, so the buttons can't drift from the balance.
    for (const b of this.toolButtons) {
      const tool = TOOL_KEYS[b.dataset.key!];
      const cost = b.querySelector('.cost');
      if (cost && tool !== 'select' && tool !== 'remove') cost.textContent = costText(BUILDINGS[TOOL_BUILDING[tool]].cost);
    }
    this.drawIcons();
    addEventListener('resize', () => this.drawIcons());
    document.fonts?.ready.then(() => this.drawIcons());
  }

  drawIcons(): void {
    for (const c of document.querySelectorAll<HTMLCanvasElement>('canvas[data-icon]')) {
      drawToolIcon(c, c.dataset.icon as Exclude<Tool, 'select' | 'remove'>);
    }
  }

  /** Set text/attr only if it changed (keeps style recalc near zero per frame). */
  private set(id: string, value: string, apply: () => void): void {
    if (this.last.get(id) === value) return;
    this.last.set(id, value);
    apply();
  }

  sync(world: World, paused: boolean, rot = 0): void {
    const { el, ui, plans } = this;
    const iron = String(world.inv[Item.Iron]);
    const plate = String(world.inv[Item.Plate]);
    this.set('iron', iron, () => (el.iron.textContent = iron));
    this.set('plate', plate, () => (el.plate.textContent = plate));

    const coreFrac = Math.max(0, world.coreHp) / BUILDINGS[Building.Core].hp;
    const corePct = `${Math.round(coreFrac * 100)}`;
    this.set('core', corePct, () => {
      el.core.style.width = `${corePct}%`;
      el.coreChip.dataset.low = String(coreFrac < 0.3);
      el.coreChip.title = `Núcleo ${corePct}%`;
    });

    const left = world.secondsToDayChange;
    const clock = `${world.isNight ? '☾' : '☀'} ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    this.set('clock', clock, () => {
      el.clock.textContent = clock;
      el.clock.dataset.night = String(world.isNight);
      el.clock.title = world.isNight ? 'Noche: enemigos más rápidos. Tiempo hasta el amanecer.' : 'Día. Tiempo hasta que anochezca.';
    });

    const alive = world.enemies.length;
    const waveLabel = world.spawning ? `Oleada ${world.wave}` : `Oleada ${world.wave + 1}`;
    const waveTime = world.spawning ? 'entrando' : `${Math.ceil(world.nextWaveIn / TICK_RATE)} s`;
    const waveSig = `${waveLabel}|${waveTime}|${alive}|${world.spawning}`;
    this.set('wave', waveSig, () => {
      el.waveLabel.textContent = alive > 0 ? `${waveLabel} · ${alive} vivos` : waveLabel;
      el.waveTime.textContent = waveTime;
      el.wave.dataset.active = String(world.spawning || alive > 0);
      el.call.hidden = world.spawning || world.phase === 'lost';
    });

    this.set('speed', `x${ui.speed}`, () => (el.speed.textContent = `x${ui.speed}`));
    this.set('paused', String(paused), () => (document.body.dataset.paused = String(paused)));
    this.set('phase', world.phase, () => (document.body.dataset.phase = world.phase));

    // Tool slots: pressed + affordable
    for (const b of this.toolButtons) {
      const tool = TOOL_KEYS[b.dataset.key!];
      const pressed = String(tool === ui.tool);
      if (b.getAttribute('aria-pressed') !== pressed) b.setAttribute('aria-pressed', pressed);
      if (tool !== 'select' && tool !== 'remove') {
        const poor = !world.canAfford(BUILDINGS[TOOL_BUILDING[tool]].cost);
        if (b.classList.contains('poor') !== poor) b.classList.toggle('poor', poor);
      }
    }

    // Context strip: plans pending > active tool > nothing.
    const ev = ui.planEval;
    const hasPlans = plans.size > 0 && world.phase !== 'lost';
    const lastPlan = [...plans.map.values()].at(-1);
    const planDirected =
      !!lastPlan && lastPlan.kind !== 'remove' && (lastPlan.kind === 'rotate' || BUILDINGS[lastPlan.b].directed);
    const showRot = DIRECTED_TOOLS.includes(ui.tool) || (hasPlans && planDirected);
    const showCtx = hasPlans || ui.tool !== 'select';
    const info = ui.tool !== 'select' ? TOOL_INFO[ui.tool] : null;
    const cost = info && ui.tool !== 'remove' ? costText(BUILDINGS[TOOL_BUILDING[ui.tool as 'belt']].cost) : '';
    const planText = ev
      ? [
          `${plans.size} ${plans.size === 1 ? 'plano' : 'planos'}`,
          ev.cost[Item.Iron] > 0 ? `${ev.cost[Item.Iron]} Fe` : ev.cost[Item.Iron] < 0 ? `+${-ev.cost[Item.Iron]} Fe` : '',
          ev.cost[Item.Plate] > 0 ? `${ev.cost[Item.Plate]} pl` : ev.cost[Item.Plate] < 0 ? `+${-ev.cost[Item.Plate]} pl` : '',
          ev.badCount ? `${ev.badCount} no válidos` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : '';
    const ctxSig = [showCtx, hasPlans, showRot, ui.tool, cost, planText, ev?.okCount, ui.dir, rot].join('|');
    this.set('ctx', ctxSig, () => {
      el.ctx.hidden = !showCtx;
      el.ctxPlans.hidden = !hasPlans;
      el.ctxRot.hidden = !showRot;
      el.dir.textContent = ARROWS[(ui.dir + rot) & 3];
      if (hasPlans) {
        el.ctxName.textContent = info?.name ?? 'Planos';
        el.ctxDesc.textContent = planText;
      } else if (info) {
        el.ctxName.textContent = cost ? `${info.name} · ${cost}` : info.name;
        el.ctxDesc.textContent = info.desc;
      }
      el.planCost.textContent = ev ? `${ev.okCount} de ${plans.size}` : '';
      el.confirm.disabled = !ev || ev.okCount === 0;
    });

    // Game over
    const lost = world.phase === 'lost';
    this.set('lost', String(lost), () => {
      el.gameover.hidden = !lost;
      if (lost) {
        const mins = Math.floor(world.tickCount / TICK_RATE / 60);
        const buildings = world.grid.tiles.size - 1;
        el.goStats.textContent =
          `Aguantaste ${world.wave - 1 < 0 ? 0 : world.wave - 1} oleadas completas en ${mins} min ` +
          `con ${buildings} edificios.`;
      }
    });
  }

  /** Brief red flash on a resource chip (e.g. a plan you can't afford). */
  flash(res: 'iron' | 'plate'): void {
    const chip = this.el[res].parentElement!;
    chip.classList.remove('flash');
    void chip.offsetWidth;
    chip.classList.add('flash');
  }
}

