// Pointer handling, built around plans (ghost buildings) so touch is precise:
//
//  Mover (default):  1-finger drag pans · tap selects a building (inspector).
//  Build tools:      tap adds a plan · tap a planned belt/miner/furnace rotates it,
//                    other plans are removed · tap an existing building selects it
//                    (tap the selected one again to rotate it).
//  Cinta/Rápida/Muro/Quitar: drag draws a clean L-shaped line from where the finger went
//                    down (not the jittery finger path); belts get directions and corners.
//  Torreta/Minero/Horno: drag pans (they're placed one at a time).
//  Two fingers:      pinch zoom + pan + twist to turn the view, always.
//
// Touch plans stay until ✓/✗. Mouse commits automatically on release, so desktop
// still feels immediate. Mouse: right click = remove, right-drag = turn view,
// middle-drag = pan, wheel = zoom.

import { Camera } from './camera';
import { dirTo, lPath, type Plan, type Plans } from './plans';
import { NO_HOVER, TOOL_BUILDING, type Tool, type UiState } from './render';
import { BUILDINGS, Building, isBelt } from './sim/defs';
import { key } from './sim/grid';
import type { Command, Phase } from './sim/world';

type Tile = [number, number];

type Mode =
  | { kind: 'idle' }
  | { kind: 'pending'; tile: Tile; sx: number; sy: number; mouse: boolean; remove: boolean }
  | { kind: 'line'; start: Tile; last: Tile; saved: Map<number, Plan | undefined>; mouse: boolean; remove: boolean }
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'gesture'; d0: number; scale0: number; anchor: [number, number]; ang0: number }
  | { kind: 'turn'; x: number }
  | { kind: 'done' }; // ignore until all pointers lift

export interface InputDeps {
  canvas: HTMLCanvasElement;
  cam: Camera;
  ui: UiState;
  plans: Plans;
  emit: (cmd: Command) => void;
  /** Building currently at a tile (read-only peek at the world). */
  buildingAt: (x: number, y: number) => number;
  dirAt: (x: number, y: number) => number;
  phase: () => Phase;
  /** Mouse strokes/clicks build immediately. */
  commit: () => void;
  onRotate?: () => void;
}

const TOUCH_SLOP = 10;
const MOUSE_SLOP = 4;
const LINE_TOOLS: Tool[] = ['belt', 'fastbelt', 'wall', 'remove'];
const isDirectedB = (b: number) => b !== Building.None && BUILDINGS[b as Exclude<Building, 0>].directed;

export function attachInput(d: InputDeps): void {
  const { canvas, cam, ui, plans, buildingAt } = d;
  const pts = new Map<number, { x: number; y: number }>();
  let mode: Mode = { kind: 'idle' };
  let rightDown = false;

  /** After losing, every tool behaves like Mover. */
  const tool = (): Tool => (d.phase() === 'lost' ? 'select' : ui.tool);

  const local = (e: PointerEvent | WheelEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const hover = (t: Tile): boolean => {
    if (t[0] === ui.hoverX && t[1] === ui.hoverY) return false;
    ui.hoverX = t[0];
    ui.hoverY = t[1];
    return true;
  };

  const isSelected = (x: number, y: number) => ui.sel !== null && ui.sel[0] === x && ui.sel[1] === y;

  // ---------------- taps ----------------

  const tap = ([x, y]: Tile, remove: boolean): void => {
    const t = remove ? 'remove' : tool();
    const b = buildingAt(x, y);
    const plan = plans.get(x, y);

    if (t === 'select') {
      if (b !== Building.None && isSelected(x, y) && isDirectedB(b)) d.emit({ type: 'rotate', x, y });
      ui.sel = b !== Building.None ? [x, y] : null;
      return;
    }
    if (t === 'remove') {
      if (plan) plans.delete(x, y);
      else if (b !== Building.None && b !== Building.Core) plans.set(x, y, { kind: 'remove' });
      return;
    }
    if (plan) {
      if (plan.kind === 'rotate' || (plan.kind === 'place' && isDirectedB(plan.b))) {
        plan.dir = (plan.dir + 1) & 3;
        ui.dir = plan.dir;
      } else {
        plans.delete(x, y);
      }
      return;
    }
    if (t === 'fastbelt' && b === Building.Belt) {
      // Tap a normal belt with Rápida: upgrade it in place, same direction.
      plans.set(x, y, { kind: 'place', b: Building.FastBelt, dir: d.dirAt(x, y) });
      return;
    }
    if (b !== Building.None) {
      if (isSelected(x, y) && isDirectedB(b)) d.emit({ type: 'rotate', x, y });
      ui.sel = [x, y];
      return;
    }
    plans.set(x, y, { kind: 'place', b: TOOL_BUILDING[t], dir: ui.dir });
  };

  // ---------------- lines ----------------

  /** Redraw this stroke's plans as an L from start to `to`, restoring what it overwrote. */
  const drawLine = (m: Extract<Mode, { kind: 'line' }>, to: Tile): void => {
    for (const [k, prev] of m.saved) {
      if (prev) plans.map.set(k, prev);
      else plans.map.delete(k);
    }
    m.saved.clear();
    m.last = to;

    const t = m.remove ? 'remove' : tool();
    const path = lPath(m.start, to);
    const put = (x: number, y: number, p: Plan | null) => {
      const k = key(x, y);
      if (!m.saved.has(k)) m.saved.set(k, plans.map.get(k));
      if (p) plans.set(x, y, p);
      else plans.delete(x, y);
    };

    path.forEach(([x, y], i) => {
      const b = buildingAt(x, y);
      if (t === 'remove') {
        if (b !== Building.None && b !== Building.Core) put(x, y, { kind: 'remove' });
        else if (plans.get(x, y)) put(x, y, null);
        return;
      }
      if (t === 'belt' || t === 'fastbelt') {
        const dir =
          i < path.length - 1 ? dirTo(path[i], path[i + 1]) : path.length > 1 ? dirTo(path[i - 1], path[i]) : ui.dir;
        const want = TOOL_BUILDING[t];
        if (b === want) put(x, y, { kind: 'rotate', dir });
        else if (b === Building.None || (t === 'fastbelt' && b === Building.Belt)) put(x, y, { kind: 'place', b: want, dir });
        else if (isBelt(b)) put(x, y, { kind: 'rotate', dir });
        if (i === path.length - 1) ui.dir = dir;
        return;
      }
      if (t === 'wall' && b === Building.None) put(x, y, { kind: 'place', b: Building.Wall, dir: 0 });
    });
  };

  // ---------------- pointer events ----------------

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    if (e.target !== canvas) return; // HTML drawn inside the canvas handles itself
    canvas.setPointerCapture(e.pointerId);
    const [sx, sy] = local(e);
    pts.set(e.pointerId, { x: sx, y: sy });
    const tile = cam.toTile(sx, sy);
    const mouse = e.pointerType === 'mouse';

    if (mouse && e.button === 1) {
      mode = { kind: 'pan', x: sx, y: sy };
      return;
    }
    if (pts.size === 1) {
      if (mouse) hover(tile);
      mode = { kind: 'pending', tile, sx, sy, mouse, remove: mouse && e.button === 2 };
      if (mouse && e.button === 2) rightDown = true;
    } else if (pts.size === 2) {
      if (mode.kind === 'line') drawLine(mode, mode.start); // collapse the stroke to its first tile
      const [a, b] = [...pts.values()];
      mode = {
        kind: 'gesture',
        d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        scale0: cam.scale,
        anchor: cam.toWorld((a.x + b.x) / 2, (a.y + b.y) / 2),
        ang0: Math.atan2(b.y - a.y, b.x - a.x),
      };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const [sx, sy] = local(e);
    const p = pts.get(e.pointerId);
    if (p) {
      p.x = sx;
      p.y = sy;
    }
    const tile = cam.toTile(sx, sy);

    switch (mode.kind) {
      case 'idle':
        if (e.pointerType === 'mouse') hover(tile);
        return;
      case 'pending': {
        const slop = mode.mouse ? MOUSE_SLOP : TOUCH_SLOP;
        if (Math.hypot(sx - mode.sx, sy - mode.sy) < slop) return;
        if (mode.mouse && rightDown) {
          // Right-drag turns the camera; a right click without dragging removes.
          cam.turning = true;
          mode = { kind: 'turn', x: sx };
          return;
        }
        const t = mode.remove ? 'remove' : tool();
        if (LINE_TOOLS.includes(t)) {
          const line: Extract<Mode, { kind: 'line' }> = {
            kind: 'line',
            start: mode.tile,
            last: mode.tile,
            saved: new Map(),
            mouse: mode.mouse,
            remove: mode.remove,
          };
          mode = line;
          drawLine(line, tile);
        } else {
          mode = { kind: 'pan', x: sx, y: sy };
        }
        if (e.pointerType === 'mouse') hover(tile);
        return;
      }
      case 'line':
        if (e.pointerType === 'mouse') hover(tile);
        if (tile[0] !== mode.last[0] || tile[1] !== mode.last[1]) drawLine(mode, tile);
        return;
      case 'turn':
        cam.turnBy(-(sx - mode.x) / 220);
        mode.x = sx;
        return;
      case 'pan':
        cam.panBy(sx - mode.x, sy - mode.y);
        mode.x = sx;
        mode.y = sy;
        return;
      case 'gesture': {
        if (pts.size < 2) return;
        const [a, b] = [...pts.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        // Twisting the two fingers turns the view with them (eased to a
        // quarter turn on release). The ground point between the fingers stays put.
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        let dAng = ang - mode.ang0;
        if (dAng > Math.PI) dAng -= Math.PI * 2;
        if (dAng < -Math.PI) dAng += Math.PI * 2;
        mode.ang0 = ang;
        cam.turning = true;
        cam.turnBy(-dAng / (Math.PI / 2));
        cam.zoomTo((mode.scale0 * dist) / mode.d0, mode.anchor, mx, my);
        return;
      }
      case 'done':
        return;
    }
  });

  const end = (e: PointerEvent, cancelled: boolean): void => {
    pts.delete(e.pointerId);
    if (!cancelled) {
      if (mode.kind === 'pending') {
        tap(mode.tile, mode.remove);
        if (mode.mouse) d.commit();
      } else if (mode.kind === 'line' && mode.mouse) {
        d.commit();
      }
    }
    if (pts.size < 2) cam.turning = false; // let it ease to a quarter turn
    rightDown = false;
    if (pts.size === 0) mode = { kind: 'idle' };
    else if (mode.kind !== 'idle') mode = { kind: 'done' };
  };
  canvas.addEventListener('pointerup', (e) => end(e, false));
  canvas.addEventListener('pointercancel', (e) => end(e, true));
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && pts.size === 0) hover([NO_HOVER, NO_HOVER]);
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const [sx, sy] = local(e);
      cam.zoomTo(cam.scale * Math.exp(-e.deltaY * 0.0015), cam.toWorld(sx, sy), sx, sy);
    },
    { passive: false },
  );
}
