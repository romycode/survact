// Inspector card for the selected building, anchored to it in the iso world.
//
// Two rendering paths, picked by feature detection:
//  - HTML-in-Canvas (WICG, Chrome origin trial / flag in 2026): the card is a
//    `drawable` child of `<canvas content="drawable">` and is painted INTO the
//    canvas with ctx.drawElementImage(). Its buttons stay real, hit-testable DOM.
//  - Everywhere else: a DOM overlay tethered with CSS anchor positioning
//    (Baseline since Jan 2026). An invisible 1px anchor follows the building;
//    position-try-fallbacks flips the card when it would leave the stage.

import type { Camera } from './camera';
import type { UiState } from './render';
import { BELT_TICKS, BUILDINGS, Building, FURNACE, ITEM_NAMES, Item, TURRET, costEntries, type Resource } from './sim/defs';
import { key } from './sim/grid';
import type { World } from './sim/world';

export type InspectorAction = 'rotate' | 'remove' | 'close';

type DrawElementCtx = CanvasRenderingContext2D & {
  drawElementImage(el: Element, x: number, y: number): unknown;
};

export const supportsHtmlInCanvas =
  typeof CanvasRenderingContext2D !== 'undefined' && 'drawElementImage' in CanvasRenderingContext2D.prototype;

const RAISE: Partial<Record<Building, number>> = {
  [Building.Core]: 1.1,
  [Building.Wall]: 0.6,
  [Building.Miner]: 0.5,
  [Building.Furnace]: 0.7,
  [Building.Turret]: 0.65,
  [Building.Belt]: 0.05,
  [Building.FastBelt]: 0.05,
};

export class Inspector {
  mode: 'canvas' | 'overlay';
  private readonly el: HTMLElement;
  private anchor: HTMLElement | null;
  private readonly stage: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly title: HTMLElement;
  private readonly hp: HTMLElement;
  private readonly body: HTMLElement;
  private readonly rotateBtn: HTMLButtonElement;
  private readonly removeBtn: HTMLButtonElement;
  private sig = '';
  private at: [number, number] | null = null;

  constructor(canvas: HTMLCanvasElement, stage: HTMLElement, onAction: (a: InspectorAction) => void) {
    this.mode = supportsHtmlInCanvas ? 'canvas' : 'overlay';
    this.stage = stage;
    this.canvas = canvas;

    this.el = document.createElement('section');
    this.el.className = `inspector ${this.mode}`;
    this.el.setAttribute('aria-label', 'Edificio seleccionado');
    this.el.hidden = true;
    this.el.innerHTML = `
      <header><b class="i-title"></b><button type="button" class="i-close" data-act="close" aria-label="Cerrar">×</button></header>
      <div class="i-hp"><i></i></div>
      <dl class="i-body"></dl>
      <footer>
        <button type="button" data-act="rotate">Girar</button>
        <button type="button" data-act="remove" class="danger">Quitar</button>
      </footer>`;
    this.title = this.el.querySelector('.i-title')!;
    this.hp = this.el.querySelector('.i-hp i')!;
    this.body = this.el.querySelector('.i-body')!;
    this.rotateBtn = this.el.querySelector('[data-act="rotate"]')!;
    this.removeBtn = this.el.querySelector('[data-act="remove"]')!;

    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act) onAction(act as InspectorAction);
    });

    this.anchor = null;
    if (this.mode === 'canvas') {
      // Current explainer spelling + the older `layoutsubtree` that shipping
      // Chromium builds still require. Harmless where unknown.
      canvas.setAttribute('content', 'drawable');
      canvas.setAttribute('layoutsubtree', '');
      this.el.setAttribute('drawable', '');
      canvas.append(this.el);
    } else {
      this.mountOverlay();
    }
  }

  private mountOverlay(): void {
    this.mode = 'overlay';
    this.el.classList.replace('canvas', 'overlay');
    this.canvas.removeAttribute('content');
    this.canvas.removeAttribute('layoutsubtree');
    this.el.removeAttribute('drawable');
    this.anchor = document.createElement('div');
    this.anchor.className = 'inspector-anchor';
    this.stage.append(this.anchor, this.el);
    document.body.dataset.htmlInCanvas = 'off';
  }

  /** Refresh content and anchor point. Cheap: DOM is touched only on change. */
  update(world: World, cam: Camera, ui: UiState): void {
    const t = ui.sel ? world.grid.get(key(ui.sel[0], ui.sel[1])) : undefined;
    if (!ui.sel || !t) {
      this.at = null;
      if (!this.el.hidden) this.el.hidden = true;
      return;
    }
    const [x, y] = ui.sel;
    this.at = cam.project(x + 0.5, y + 0.5, RAISE[t.b] ?? 0.5);
    if (this.anchor) {
      // left/top (not transform): anchor positioning tracks the layout box.
      this.anchor.style.left = `${this.at[0]}px`;
      this.anchor.style.top = `${this.at[1]}px`;
    }

    const def = BUILDINGS[t.b];
    const rows: [string, string][] = [];
    switch (t.b) {
      case Building.Core:
        rows.push(['Hierro', String(world.inv[Item.Iron])], ['Placas', String(world.inv[Item.Plate])]);
        break;
      case Building.Turret:
        rows.push(['Munición', `${t.ammo} / ${TURRET.maxAmmo}`]);
        if (t.ammo === 0) rows.push(['Estado', 'Sin munición']);
        break;
      case Building.Furnace:
        rows.push(
          ['Entrada', `${t.inp} / ${FURNACE.maxInput} Fe`],
          ['Salida', `${t.out} / ${FURNACE.maxOutput} pl`],
          ['Estado', t.cd > 0 ? `Fundiendo ${Math.round((1 - t.cd / FURNACE.ticksPerPlate) * 100)}%` : 'En espera'],
        );
        break;
      case Building.Miner:
        {
          const left = world.oreLeft(x, y);
          rows.push(
            ['Veta', left > 0 ? `${left} Fe` : 'Agotada'],
            ['Estado', left === 0 ? 'Parado' : t.cd > 0 ? 'Extrayendo' : 'Salida bloqueada'],
          );
        }
        break;
      case Building.Belt:
      case Building.FastBelt:
        rows.push(
          ['Velocidad', `${(60 / BELT_TICKS[t.b]!).toFixed(0)} tiles/s`],
          ['Lleva', t.item ? ITEM_NAMES[t.item as Resource] : 'Nada'],
        );
        break;
      case Building.Wall:
        rows.push(['Función', 'Bloquea y desvía']);
        break;
    }
    const refund = costEntries(def.cost)
      .map(([r, n]) => `${n} ${r === Item.Iron ? 'Fe' : 'pl'}`)
      .join(' ');
    const canRemove = t.b !== Building.Core && world.phase !== 'lost';
    const hpPct = Math.max(0, Math.round((t.hp / def.hp) * 100));
    const sig = [x, y, def.name, hpPct, rows.flat().join(','), def.directed, canRemove, refund].join('|');
    if (sig !== this.sig) {
      this.sig = sig;
      this.title.textContent = def.name;
      this.hp.style.width = `${hpPct}%`;
      this.body.replaceChildren(
        ...rows.flatMap(([k, v]) => {
          const dt = document.createElement('dt');
          dt.textContent = k;
          const dd = document.createElement('dd');
          dd.textContent = v;
          return [dt, dd];
        }),
      );
      this.rotateBtn.hidden = !def.directed;
      this.removeBtn.hidden = !canRemove;
      this.removeBtn.textContent = refund ? `Quitar (+${refund})` : 'Quitar';
    }
    if (this.el.hidden) this.el.hidden = false;
  }

  /** HTML-in-Canvas path: paint the card into the canvas, above the building. */
  draw(ctx: CanvasRenderingContext2D, dpr: number, cssW: number, cssH: number): void {
    if (this.mode !== 'canvas' || !this.at || this.el.hidden) return;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const m = 8;
    const x = Math.min(Math.max(this.at[0] - w / 2, m), cssW - w - m);
    let y = this.at[1] - h - 12;
    if (y < m) y = Math.min(this.at[1] + 16, cssH - h - m); // flip below, like position-try
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    try {
      (ctx as DrawElementCtx).drawElementImage(this.el, x, y);
    } catch (err) {
      // API shape still moving between builds: fall back to the anchored overlay.
      console.warn('HTML-in-Canvas no disponible, uso overlay anclado', err);
      this.mountOverlay();
    }
  }
}
