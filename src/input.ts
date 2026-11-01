// Pointer handling. Touch rules, chosen so nothing gets built by accident:
//  - Tap = act on that tile (on release, so a 2nd finger can still cancel it).
//    Tapping an existing belt/miner with its own tool rotates it.
//  - One-finger drag with Muro/Cinta/Quitar = paint. Belts take the drag direction,
//    and the previous belt turns to feed the new one, so corners come out right.
//  - Drag with Torreta/Minero = nothing (they're expensive).
//  - Two fingers = pinch zoom + pan; cancels whatever the first finger was doing.
// Mouse acts immediately on press; wheel zooms, right-click removes.

import { Camera } from './camera';
import { TOOL_BUILDING, type UiState } from './render';
import { Building } from './sim/defs';
import type { Command } from './sim/world';

const DRAG_SLOP_PX = 10;

type Tile = [number, number];

type Mode =
  | { kind: 'idle' }
  | { kind: 'pending'; tile: Tile; sx: number; sy: number }
  | { kind: 'paint'; remove: boolean; last: Tile }
  | { kind: 'gesture'; d0: number; zoom0: number; anchor: [number, number] }
  | { kind: 'done' }; // ignore until all fingers lift

export interface InputDeps {
  canvas: HTMLCanvasElement;
  cam: Camera;
  ui: UiState;
  emit: (cmd: Command) => void;
  /** Building currently at a tile (read-only peek at the world). */
  buildingAt: (x: number, y: number) => number;
  /** Whether the building at a tile has a facing (belt, miner). */
  isDirected: (x: number, y: number) => boolean;
}

export function attachInput({ canvas, cam, ui, emit, buildingAt, isDirected }: InputDeps): void {
  const pts = new Map<number, { x: number; y: number }>();
  let mode: Mode = { kind: 'idle' };

  const local = (e: PointerEvent | WheelEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const paintable = (): boolean => ui.tool === 'wall' || ui.tool === 'belt' || ui.tool === 'remove';

  /** Single action on a tile (tap / click / first tile of a paint). */
  const act = ([x, y]: Tile, remove: boolean): void => {
    if (remove || ui.tool === 'remove') {
      emit({ type: 'remove', x, y });
      return;
    }
    // Tapping any belt/miner rotates it, whatever tool is active.
    if (isDirected(x, y)) {
      emit({ type: 'rotate', x, y });
      ui.sel = [x, y];
      return;
    }
    const b = TOOL_BUILDING[ui.tool];
    if (buildingAt(x, y) !== Building.None) return;
    emit({ type: 'place', x, y, building: b, dir: ui.dir });
    if (b === Building.Belt || b === Building.Miner) ui.sel = [x, y];
  };

  /** Paint from the last tile to `to`, one 4-connected step at a time (fast swipes skip tiles). */
  const paintTo = (m: Extract<Mode, { kind: 'paint' }>, to: Tile): void => {
    let [x, y] = m.last;
    while (x !== to[0] || y !== to[1]) {
      const dx = to[0] - x;
      const dy = to[1] - y;
      const d = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 0 : 2) : dy > 0 ? 1 : 3;
      const nx = x + (d === 0 ? 1 : d === 2 ? -1 : 0);
      const ny = y + (d === 1 ? 1 : d === 3 ? -1 : 0);
      if (m.remove || ui.tool === 'remove') {
        emit({ type: 'remove', x: nx, y: ny });
      } else if (ui.tool === 'belt') {
        emit({ type: 'rotate', x, y, dir: d }); // previous belt now feeds this one
        if (buildingAt(nx, ny) === Building.Belt) emit({ type: 'rotate', x: nx, y: ny, dir: d });
        else emit({ type: 'place', x: nx, y: ny, building: Building.Belt, dir: d });
        ui.dir = d;
        ui.sel = [nx, ny];
      } else {
        emit({ type: 'place', x: nx, y: ny, building: TOOL_BUILDING[ui.tool as 'wall'] });
      }
      x = nx;
      y = ny;
    }
    m.last = to;
  };

  const pair = (): [{ x: number; y: number }, { x: number; y: number }] => {
    const [a, b] = [...pts.values()];
    return [a, b];
  };

  const hover = (t: Tile): boolean => {
    if (t[0] === ui.hoverX && t[1] === ui.hoverY) return false;
    ui.hoverX = t[0];
    ui.hoverY = t[1];
    return true;
  };

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const [sx, sy] = local(e);
    pts.set(e.pointerId, { x: sx, y: sy });
    const tile = cam.toTile(sx, sy);

    if (e.pointerType === 'mouse') {
      hover(tile);
      const remove = e.button === 2;
      act(tile, remove);
      mode = remove || paintable() ? { kind: 'paint', remove, last: tile } : { kind: 'done' };
      return;
    }

    if (pts.size === 1) {
      hover(tile);
      mode = { kind: 'pending', tile, sx, sy };
    } else if (pts.size === 2) {
      const [a, b] = pair();
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      mode = {
        kind: 'gesture',
        d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        zoom0: cam.zoom,
        anchor: cam.toView(mx, my),
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
        if (Math.hypot(sx - mode.sx, sy - mode.sy) < DRAG_SLOP_PX) return;
        if (!paintable()) {
          mode = { kind: 'done' };
          return;
        }
        // Start a paint. Placing the first belt with ui.dir is fine: the first
        // step rotates it towards the drag.
        act(mode.tile, false);
        mode = { kind: 'paint', remove: false, last: mode.tile };
        hover(tile);
        paintTo(mode, tile);
        return;
      }
      case 'paint':
        if (hover(tile)) paintTo(mode, tile);
        return;
      case 'gesture': {
        if (pts.size < 2) return;
        const [a, b] = pair();
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        cam.zoomTo((mode.zoom0 * d) / mode.d0, mode.anchor, (a.x + b.x) / 2, (a.y + b.y) / 2);
        return;
      }
      case 'done':
        return;
    }
  });

  const end = (e: PointerEvent, cancelled: boolean): void => {
    pts.delete(e.pointerId);
    if (mode.kind === 'pending' && !cancelled) act(mode.tile, false);
    if (pts.size === 0) mode = { kind: 'idle' };
    else if (mode.kind !== 'idle') mode = { kind: 'done' };
  };
  canvas.addEventListener('pointerup', (e) => end(e, false));
  canvas.addEventListener('pointercancel', (e) => end(e, true));
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && pts.size === 0) hover([-1, -1]);
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const [sx, sy] = local(e);
      cam.zoomTo(cam.zoom * Math.exp(-e.deltaY * 0.0015), cam.toView(sx, sy), sx, sy);
    },
    { passive: false },
  );
}
