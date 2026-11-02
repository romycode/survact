// Grid-aligned 3/4 camera over an infinite world.
//
// The grid's x axis runs left→right on screen and y runs top→bottom; the
// camera is tilted, so the ground is squashed vertically and height rises
// up the screen:
//   sx = ox + x · s
//   sy = oy + y · s · DEPTH − z · s · RISE
// s = CSS px per tile (width). You see the top and the front (+y) face of
// everything; draw order is back (small y) to front (large y).

/** Vertical squash of the ground: a tile is s wide and s·DEPTH tall. */
export const DEPTH = 0.72;
/** Screen px per unit of height, as a fraction of s. */
export const RISE = 0.68;

export interface Proj {
  scale: number;
  project(x: number, y: number, z?: number): [number, number];
}

/** A projector with (0,0,0) at screen point (ax, ay) — for sprites and icons. */
export function projAt(scale: number, ax: number, ay: number): Proj {
  return {
    scale,
    project: (x, y, z = 0) => [ax + x * scale, ay + y * scale * DEPTH - z * scale * RISE],
  };
}

export class Camera implements Proj {
  scale = 48;
  /** World point at the centre of the screen. */
  cx = 0.5;
  cy = 0.5;
  private cssW = 0;
  private cssH = 0;
  private sized = false;

  static readonly MIN_SCALE = 14;
  static readonly MAX_SCALE = 140;

  get ox(): number {
    return this.cssW / 2 - this.cx * this.scale;
  }
  get oy(): number {
    return this.cssH / 2 - this.cy * this.scale * DEPTH;
  }

  resize(cssW: number, cssH: number): void {
    this.cssW = cssW;
    this.cssH = cssH;
    if (!this.sized) {
      // ~8 tiles across the short side: tappable on a phone.
      this.scale = clamp(Math.min(cssW, cssH) / 8, Camera.MIN_SCALE, Camera.MAX_SCALE);
      this.sized = true;
    }
  }

  project(x: number, y: number, z = 0): [number, number] {
    const s = this.scale;
    return [this.ox + x * s, this.oy + y * s * DEPTH - z * s * RISE];
  }

  /** Canvas-local CSS px -> ground-plane world coords (fractional tiles). */
  toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.ox) / this.scale, (sy - this.oy) / (this.scale * DEPTH)];
  }

  toTile(sx: number, sy: number): [number, number] {
    const [x, y] = this.toWorld(sx, sy);
    return [Math.floor(x), Math.floor(y)];
  }

  /** Set scale keeping world point `anchor` under screen point (sx, sy). */
  zoomTo(scale: number, anchor: [number, number], sx: number, sy: number): void {
    this.scale = clamp(scale, Camera.MIN_SCALE, Camera.MAX_SCALE);
    this.cx = anchor[0] - (sx - this.cssW / 2) / this.scale;
    this.cy = anchor[1] - (sy - this.cssH / 2) / (this.scale * DEPTH);
  }

  panBy(dxPx: number, dyPx: number): void {
    this.cx -= dxPx / this.scale;
    this.cy -= dyPx / (this.scale * DEPTH);
  }

  centerOn(x: number, y: number): void {
    this.cx = x;
    this.cy = y;
  }

  /** Tile range covering the screen (inclusive), padded for tall buildings below the edge. */
  visible(): { x0: number; y0: number; x1: number; y1: number } {
    const [x0, y0] = this.toWorld(0, 0);
    const [x1, y1] = this.toWorld(this.cssW, this.cssH);
    return { x0: Math.floor(x0) - 1, y0: Math.floor(y0) - 1, x1: Math.ceil(x1), y1: Math.ceil(y1) + 3 };
  }

  /** Ground-plane transform: afterwards, draw in tile units at z = 0. */
  applyGround(ctx: CanvasRenderingContext2D, dpr: number): void {
    const s = this.scale;
    ctx.setTransform(dpr * s, 0, 0, dpr * s * DEPTH, dpr * this.ox, dpr * this.oy);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
