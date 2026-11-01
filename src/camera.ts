// Isometric camera over an infinite world.
//
// World tile (x, y, z) -> screen:
//   sx = ox + (x - y) * s/2
//   sy = oy + (x + y) * s/4 - z * s/2
// where s = width of a tile diamond in CSS px. +x goes down-right, +y down-left.
// The ground plane (z = 0) is an affine map, so flat things can be drawn with
// ctx.setTransform in tile units; raised things use project().

export class Camera {
  scale = 48;
  cx = 0.5; // world point at the centre of the screen
  cy = 0.5;
  private cssW = 0;
  private cssH = 0;
  private sized = false;

  static readonly MIN_SCALE = 16;
  static readonly MAX_SCALE = 160;

  get ox(): number {
    return this.cssW / 2 - (this.cx - this.cy) * (this.scale / 2);
  }
  get oy(): number {
    return this.cssH / 2 - (this.cx + this.cy) * (this.scale / 4);
  }

  resize(cssW: number, cssH: number): void {
    this.cssW = cssW;
    this.cssH = cssH;
    if (!this.sized) {
      // ~8 tile diamonds across the short side: tappable on a phone.
      this.scale = clamp(Math.min(cssW, cssH) / 8, Camera.MIN_SCALE, Camera.MAX_SCALE);
      this.sized = true;
    }
  }

  project(x: number, y: number, z = 0): [number, number] {
    const s = this.scale;
    return [this.ox + (x - y) * (s / 2), this.oy + (x + y) * (s / 4) - z * (s / 2)];
  }

  /** Canvas-local CSS px -> ground-plane world coords (fractional tiles). */
  toWorld(sx: number, sy: number): [number, number] {
    const u = (sx - this.ox) / (this.scale / 2); // x - y
    const v = (sy - this.oy) / (this.scale / 4); // x + y
    return [(u + v) / 2, (v - u) / 2];
  }

  toTile(sx: number, sy: number): [number, number] {
    const [x, y] = this.toWorld(sx, sy);
    return [Math.floor(x), Math.floor(y)];
  }

  /** Set scale keeping world point `anchor` under screen point (sx, sy). */
  zoomTo(scale: number, anchor: [number, number], sx: number, sy: number): void {
    this.scale = clamp(scale, Camera.MIN_SCALE, Camera.MAX_SCALE);
    const U = (sx - this.cssW / 2) / (this.scale / 2);
    const V = (sy - this.cssH / 2) / (this.scale / 4);
    this.cx = anchor[0] - (U + V) / 2;
    this.cy = anchor[1] - (V - U) / 2;
  }

  panBy(dxPx: number, dyPx: number): void {
    const du = dxPx / (this.scale / 2);
    const dv = dyPx / (this.scale / 4);
    this.cx -= (du + dv) / 2;
    this.cy -= (dv - du) / 2;
  }

  centerOn(x: number, y: number): void {
    this.cx = x;
    this.cy = y;
  }

  /** Tile range covering the screen (inclusive), padded for tall buildings. */
  visible(): { x0: number; y0: number; x1: number; y1: number } {
    const pts = [
      this.toWorld(0, 0),
      this.toWorld(this.cssW, 0),
      this.toWorld(0, this.cssH),
      this.toWorld(this.cssW, this.cssH),
    ];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return {
      x0: Math.floor(Math.min(...xs)) - 1,
      y0: Math.floor(Math.min(...ys)) - 1,
      x1: Math.ceil(Math.max(...xs)) + 2,
      y1: Math.ceil(Math.max(...ys)) + 2,
    };
  }

  /** Ground-plane transform: afterwards, draw in tile units at z = 0. */
  applyGround(ctx: CanvasRenderingContext2D, dpr: number): void {
    const s = this.scale;
    ctx.setTransform((dpr * s) / 2, (dpr * s) / 4, (-dpr * s) / 2, (dpr * s) / 4, dpr * this.ox, dpr * this.oy);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
