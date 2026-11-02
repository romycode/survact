// Isometric camera over an infinite world, with 90° view rotation.
//
// World (x, y) is first rotated into *view* space (u, v) by `rot` quarter
// turns, then projected:
//   sx = ox + (u - v) * s/2
//   sy = oy + (u + v) * s/4 - z * s/2
// where s = width of a tile diamond in CSS px. In view space +u goes
// down-right and +v down-left, so "visible faces" and back-to-front order
// are always the same there; only the mapping from world changes.
//
// project()/toWorld() work in world coords. Code that draws solid shapes
// (buildings) works in view coords through `view` (a projector without the
// rotation) so face culling stays trivial.

export interface Proj {
  scale: number;
  project(x: number, y: number, z?: number): [number, number];
}

export class Camera implements Proj {
  scale = 48;
  /** World point at the centre of the screen. */
  cx = 0.5;
  cy = 0.5;
  /** View rotation in quarter turns (0..3). */
  rot = 0;
  private cssW = 0;
  private cssH = 0;
  private sized = false;

  static readonly MIN_SCALE = 16;
  static readonly MAX_SCALE = 160;

  /** Projector in view space (no rotation): for buildings and view-space chunks. */
  readonly view: Proj;

  constructor() {
    const self = this;
    this.view = {
      get scale() {
        return self.scale;
      },
      project: (u: number, v: number, z = 0) => self.projectView(u, v, z),
    };
  }

  // ---------------- rotation helpers ----------------

  /** World point -> view point (continuous). */
  toView(x: number, y: number): [number, number] {
    switch (this.rot) {
      case 1:
        return [-y, x];
      case 2:
        return [-x, -y];
      case 3:
        return [y, -x];
      default:
        return [x, y];
    }
  }

  /** View point -> world point (continuous). */
  fromView(u: number, v: number): [number, number] {
    switch (this.rot) {
      case 1:
        return [v, -u];
      case 2:
        return [-u, -v];
      case 3:
        return [-v, u];
      default:
        return [u, v];
    }
  }

  /** World tile -> the view tile it occupies (min corner of the rotated square). */
  viewTile(x: number, y: number): [number, number] {
    switch (this.rot) {
      case 1:
        return [-y - 1, x];
      case 2:
        return [-x - 1, -y - 1];
      case 3:
        return [y, -x - 1];
      default:
        return [x, y];
    }
  }

  /** View tile -> world tile. */
  worldTile(u: number, v: number): [number, number] {
    switch (this.rot) {
      case 1:
        return [v, -u - 1];
      case 2:
        return [-u - 1, -v - 1];
      case 3:
        return [-v - 1, u];
      default:
        return [u, v];
    }
  }

  /** World direction (0=E 1=S 2=W 3=N) as seen in view space. */
  viewDir(d: number): number {
    return (d + this.rot) & 3;
  }

  /** Rotate the view a quarter turn around the screen centre (+1 = clockwise on screen). */
  rotate(step: 1 | -1): void {
    this.rot = (this.rot + (step === 1 ? 3 : 1)) & 3;
  }

  // ---------------- projection ----------------

  private get viewCenter(): [number, number] {
    return this.toView(this.cx, this.cy);
  }

  get ox(): number {
    const [u, v] = this.viewCenter;
    return this.cssW / 2 - (u - v) * (this.scale / 2);
  }
  get oy(): number {
    const [u, v] = this.viewCenter;
    return this.cssH / 2 - (u + v) * (this.scale / 4);
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

  projectView(u: number, v: number, z = 0): [number, number] {
    const s = this.scale;
    return [this.ox + (u - v) * (s / 2), this.oy + (u + v) * (s / 4) - z * (s / 2)];
  }

  project(x: number, y: number, z = 0): [number, number] {
    const [u, v] = this.toView(x, y);
    return this.projectView(u, v, z);
  }

  /** Canvas-local CSS px -> ground-plane view coords. */
  toViewPoint(sx: number, sy: number): [number, number] {
    const a = (sx - this.ox) / (this.scale / 2); // u - v
    const b = (sy - this.oy) / (this.scale / 4); // u + v
    return [(a + b) / 2, (b - a) / 2];
  }

  /** Canvas-local CSS px -> ground-plane world coords (fractional tiles). */
  toWorld(sx: number, sy: number): [number, number] {
    const [u, v] = this.toViewPoint(sx, sy);
    return this.fromView(u, v);
  }

  toTile(sx: number, sy: number): [number, number] {
    const [x, y] = this.toWorld(sx, sy);
    return [Math.floor(x), Math.floor(y)];
  }

  /** Set scale keeping world point `anchor` under screen point (sx, sy). */
  zoomTo(scale: number, anchor: [number, number], sx: number, sy: number): void {
    this.scale = clamp(scale, Camera.MIN_SCALE, Camera.MAX_SCALE);
    const [au, av] = this.toView(anchor[0], anchor[1]);
    const U = (sx - this.cssW / 2) / (this.scale / 2);
    const V = (sy - this.cssH / 2) / (this.scale / 4);
    const [cx, cy] = this.fromView(au - (U + V) / 2, av - (V - U) / 2);
    this.cx = cx;
    this.cy = cy;
  }

  panBy(dxPx: number, dyPx: number): void {
    const du = dxPx / (this.scale / 2);
    const dv = dyPx / (this.scale / 4);
    const [wx, wy] = this.fromView((du + dv) / 2, (dv - du) / 2);
    this.cx -= wx;
    this.cy -= wy;
  }

  centerOn(x: number, y: number): void {
    this.cx = x;
    this.cy = y;
  }

  /** View-tile range covering the screen (inclusive), padded for tall buildings. */
  visibleView(): { x0: number; y0: number; x1: number; y1: number } {
    const pts = [
      this.toViewPoint(0, 0),
      this.toViewPoint(this.cssW, 0),
      this.toViewPoint(0, this.cssH),
      this.toViewPoint(this.cssW, this.cssH),
    ];
    const us = pts.map((p) => p[0]);
    const vs = pts.map((p) => p[1]);
    return {
      x0: Math.floor(Math.min(...us)) - 1,
      y0: Math.floor(Math.min(...vs)) - 1,
      x1: Math.ceil(Math.max(...us)) + 2,
      y1: Math.ceil(Math.max(...vs)) + 2,
    };
  }

  /** World-tile range covering the screen (inclusive), padded. */
  visible(): { x0: number; y0: number; x1: number; y1: number } {
    const v = this.visibleView();
    const a = this.fromView(v.x0, v.y0);
    const b = this.fromView(v.x1 + 1, v.y1 + 1);
    return {
      x0: Math.floor(Math.min(a[0], b[0])) - 1,
      y0: Math.floor(Math.min(a[1], b[1])) - 1,
      x1: Math.ceil(Math.max(a[0], b[0])),
      y1: Math.ceil(Math.max(a[1], b[1])),
    };
  }

  /** Ground-plane transform in WORLD coords (rotation included). */
  applyGround(ctx: CanvasRenderingContext2D, dpr: number): void {
    const s = this.scale;
    const a = s / 2;
    const b = s / 4;
    const c = -s / 2;
    const d = s / 4;
    // u = r00 x + r01 y, v = r10 x + r11 y
    const [r00, r10] = this.toView(1, 0);
    const [r01, r11] = this.toView(0, 1);
    ctx.setTransform(
      dpr * (a * r00 + c * r10),
      dpr * (b * r00 + d * r10),
      dpr * (a * r01 + c * r11),
      dpr * (b * r01 + d * r11),
      dpr * this.ox,
      dpr * this.oy,
    );
  }

  /** Ground-plane transform in VIEW coords (no rotation). */
  applyGroundView(ctx: CanvasRenderingContext2D, dpr: number): void {
    const s = this.scale;
    ctx.setTransform((dpr * s) / 2, (dpr * s) / 4, (-dpr * s) / 2, (dpr * s) / 4, dpr * this.ox, dpr * this.oy);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
