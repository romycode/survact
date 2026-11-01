// Pointer handling. Touch rules, chosen so nothing gets built by accident:
//  - Tap = act on that tile (on release, so a 2nd finger can still cancel it).
//  - One-finger drag with Muro/Quitar = paint; with Torreta = nothing (turrets are expensive).
//  - Two fingers = pinch zoom + pan; cancels whatever the first finger was doing.
// Mouse acts immediately on press (no gestures to disambiguate); wheel zooms, right-click removes.

import { Camera } from './camera';
import type { UiState } from './render';
import { Building } from './sim/defs';
import type { Command } from './sim/world';

const DRAG_SLOP_PX = 10;

type Mode =
  | { kind: 'idle' }
  | { kind: 'pending'; tile: [number, number]; sx: number; sy: number }
  | { kind: 'paint'; remove: boolean }
  | { kind: 'gesture'; d0: number; zoom0: number; anchor: [number, number] }
  | { kind: 'done' }; // a gesture ended with fingers still down: ignore until all lift

export function attachInput(
  canvas: HTMLCanvasElement,
  cam: Camera,
  ui: UiState,
  emit: (cmd: Command) => void,
): void {
  const pts = new Map<number, { x: number; y: number }>();
  let mode: Mode = { kind: 'idle' };

  const local = (e: PointerEvent | WheelEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const act = ([x, y]: [number, number], remove: boolean): void => {
    if (remove || ui.tool === 'remove') emit({ type: 'remove', x, y });
    else emit({ type: 'place', x, y, building: ui.tool === 'wall' ? Building.Wall : Building.Turret });
  };

  const pair = (): [{ x: number; y: number }, { x: number; y: number }] => {
    const [a, b] = [...pts.values()];
    return [a, b];
  };

  const hover = (t: [number, number]): boolean => {
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
      mode = { kind: 'paint', remove };
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
        if (ui.tool === 'turret') {
          mode = { kind: 'done' };
          return;
        }
        act(mode.tile, false);
        mode = { kind: 'paint', remove: false };
        if (hover(tile)) act(tile, false);
        return;
      }
      case 'paint':
        if (hover(tile)) act(tile, mode.remove);
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
