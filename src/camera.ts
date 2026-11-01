// View transform. The sim grid is landscape (w > h); on a portrait screen we
// transpose it so enemies come from the top and the core sits at the bottom.
// That makes tiles ~2x bigger on phones without touching the simulation.
//
// "View" space = tile units after the optional transpose. Zoom/pan live there.

export class Camera {
  rot = false;
  zoom = 1;
  cx = 0; // view-space point at the centre of the screen
  cy = 0;
  private fit = 1;
  private viewW = 0;
  private viewH = 0;
  private cssW = 0;
  private cssH = 0;

  static readonly MAX_ZOOM = 4;

  get scale(): number {
    return this.fit * this.zoom;
  }
  get ox(): number {
    return this.cssW / 2 - this.cx * this.scale;
  }
  get oy(): number {
    return this.cssH / 2 - this.cy * this.scale;
  }

  resize(cssW: number, cssH: number, gridW: number, gridH: number): void {
    const rot = cssH > cssW !== gridH > gridW;
    const reset = rot !== this.rot || this.viewW === 0;
    this.rot = rot;
    this.cssW = cssW;
    this.cssH = cssH;
    this.viewW = rot ? gridH : gridW;
    this.viewH = rot ? gridW : gridH;
    this.fit = Math.min(cssW / this.viewW, cssH / this.viewH);
    if (reset) {
      this.zoom = 1;
      this.cx = this.viewW / 2;
      this.cy = this.viewH / 2;
    }
    this.clamp();
  }

  /** Canvas-local CSS px -> view-space tile units. */
  toView(sx: number, sy: number): [number, number] {
    return [(sx - this.ox) / this.scale, (sy - this.oy) / this.scale];
  }

  /** Canvas-local CSS px -> sim tile coords. */
  toTile(sx: number, sy: number): [number, number] {
    const [u, v] = this.toView(sx, sy);
    return this.rot ? [Math.floor(v), Math.floor(u)] : [Math.floor(u), Math.floor(v)];
  }

  /** Sim coords -> view coords (for things drawn without the transpose, like bars). */
  simToView(x: number, y: number): [number, number] {
    return this.rot ? [y, x] : [x, y];
  }

  /** Set zoom keeping the view point `anchor` under screen point (sx, sy). */
  zoomTo(zoom: number, anchor: [number, number], sx: number, sy: number): void {
    this.zoom = Math.min(Camera.MAX_ZOOM, Math.max(1, zoom));
    this.cx = anchor[0] - (sx - this.cssW / 2) / this.scale;
    this.cy = anchor[1] - (sy - this.cssH / 2) / this.scale;
    this.clamp();
  }

  panBy(dxPx: number, dyPx: number): void {
    this.cx -= dxPx / this.scale;
    this.cy -= dyPx / this.scale;
    this.clamp();
  }

  /** Sim-space transform: draw in tile units with sim coordinates. */
  applySim(ctx: CanvasRenderingContext2D): void {
    this.applyView(ctx);
    if (this.rot) ctx.transform(0, 1, 1, 0, 0, 0);
  }

  applyView(ctx: CanvasRenderingContext2D): void {
    ctx.translate(this.ox, this.oy);
    ctx.scale(this.scale, this.scale);
  }

  private clamp(): void {
    const s = this.scale;
    this.cx = clampAxis(this.cx, this.viewW, this.cssW / 2 / s);
    this.cy = clampAxis(this.cy, this.viewH, this.cssH / 2 / s);
  }
}

function clampAxis(c: number, size: number, half: number): number {
  if (size <= half * 2) return size / 2; // fits: centre it
  return Math.min(size - half, Math.max(half, c));
}
