// Static ground: grass, decorations, water, foam, banks, ore and grid lines.
//
// The world's ground never changes except ore running out, so instead of
// re-painting every visible tile every frame (thousands of Map lookups,
// fills and strokes), it's painted once per CHUNK×CHUNK block into an
// offscreen bitmap at a quantised zoom level and blitted with one drawImage.
//
// - At rest, chunks are painted at the exact zoom and blitted 1:1 on whole
//   pixels (crisp and the cheapest possible drawImage). While zooming they're
//   reused scaled, and re-painted to the new zoom once the camera settles, a
//   few per frame so there's never a spike.
// - Zoomed far in (few tiles on screen, bitmaps would be huge) it falls back
//   to painting directly, which is cheap there.
// - Ore chunks re-render when a tile's *visible* state changes (nugget count
//   or depletion), checked every few frames — not on every mined unit.
// - LRU-evicted so memory stays around a few screens' worth.

import type { Camera } from './camera';

/** Maps view tiles to world tiles for a given rotation (the camera does this). */
export interface ViewMap {
  rot: number;
  worldTile(u: number, v: number): [number, number];
}

/** A world-space offset inside a tile, as seen in view space. */
function rotLocal(rot: number, ox: number, oy: number): [number, number] {
  switch (rot) {
    case 1:
      return [1 - oy, ox];
    case 2:
      return [1 - ox, 1 - oy];
    case 3:
      return [oy, 1 - ox];
    default:
      return [ox, oy];
  }
}
import { Ground } from './sim/terrain';
import type { World } from './sim/world';

export const CHUNK = 8;
/** Above this many device px per tile, paint directly instead of caching. */
const MAX_DEVICE_SCALE = 160;
const SIG_CHECK_FRAMES = 12;
/** Frames the zoom must hold still before chunks are re-painted at the new scale. */
const SETTLE_FRAMES = 6;
/** Re-paints of already-visible chunks per frame (new chunks always paint). */
const REPAINT_BUDGET = 6;

/** Water sits this far below land (also the bank height). */
export const BANK = 0.28;

export const T = {
  ink: '#2b2340',
  land: '#8fd16a',
  landAlt: '#86c962',
  grid: 'rgba(43,35,64,0.07)',
  tuft: '#5ea84a',
  flowerA: '#fff4d6',
  flowerB: '#ffd34d',
  flowerCore: '#ff9f43',
  bank: '#e8c27f',
  bankDark: '#c99a5a',
  water: '#46c2e0',
  waterLight: '#7fdcf0',
  foam: '#e9fbff',
  ore: '#7a5235',
  oreHi: '#c08a5a',
  oreGround: '#d4a46a',
};

/** Nuggets drawn for a given amount of ore (0 = depleted / none). */
export function oreNuggets(left: number): number {
  return left === 0 ? 0 : 1 + Math.min(4, Math.round(left / 200));
}

const hash2 = (x: number, y: number, s: number) =>
  ((Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 83492791)) >>> 0) / 4294967296;

/**
 * Paint VIEW tiles [x0..x1]×[y0..y1] (caller sets the un-rotated iso ground
 * transform). Everything that depends on the world (terrain, hashes, ore) is
 * looked up through `vm`, so the same world looks the same from any side.
 * `scaleCss` = CSS px per tile, for level-of-detail.
 */
export function paintTerrain(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  world: World,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  scaleCss: number,
  vm: ViewMap,
): void {
  const { terrain } = world;
  const rot = vm.rot;
  const wt = (u: number, v: number) => vm.worldTile(u, v);
  const gpx = 2 / scaleCss; // ~1 CSS px in ground units
  const W = x1 - x0 + 1;
  const H = y1 - y0 + 1;
  // One terrain lookup per tile (plus a 1-tile border for edges), reused by every layer.
  const g = new Uint8Array((W + 1) * (H + 1));
  for (let y = y0 - 1; y <= y1; y++) {
    for (let x = x0 - 1; x <= x1; x++) {
      const [wx, wy] = wt(x, y);
      g[(y - y0 + 1) * (W + 1) + (x - x0 + 1)] = terrain.at(wx, wy);
    }
  }
  const at = (x: number, y: number) => g[(y - y0 + 1) * (W + 1) + (x - x0 + 1)];

  // Grass checker
  for (const [col, par] of [[T.land, 1], [T.landAlt, 0]] as const) {
    ctx.fillStyle = col;
    ctx.beginPath();
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (at(x, y) !== Ground.Water && ((x + y) & 1) === par) ctx.rect(x, y, 1.01, 1.01);
    ctx.fill();
  }

  // Decorations (fixed per tile). Buildings cover them, so no need to skip occupied tiles.
  if (scaleCss >= 20) {
    ctx.lineCap = 'round';
    ctx.lineWidth = 2.2 * gpx;
    ctx.strokeStyle = T.tuft;
    ctx.beginPath();
    const flowers: [number, number, boolean][] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (at(x, y) !== Ground.Land) continue;
        const [wx, wy] = wt(x, y);
        const r = hash2(wx, wy, 1);
        if (r > 0.3) continue;
        const [ox, oy] = rotLocal(rot, 0.2 + hash2(wx, wy, 2) * 0.6, 0.2 + hash2(wx, wy, 3) * 0.6);
        if (r < 0.06) {
          flowers.push([x + ox, y + oy, r < 0.03]);
        } else {
          for (const [dx, dy] of [[-0.09, 0.02], [0, 0], [0.02, -0.09]]) {
            ctx.moveTo(x + ox + dx, y + oy + dy);
            ctx.lineTo(x + ox + dx - 0.1, y + oy + dy - 0.1);
          }
        }
      }
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
    for (const [fx, fy, white] of flowers) {
      ctx.fillStyle = white ? T.flowerA : T.flowerB;
      ctx.beginPath();
      ctx.arc(fx, fy, 0.07, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = T.flowerCore;
      ctx.beginPath();
      ctx.arc(fx, fy, 0.03, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Water, wave crests, banks (owned by the water tile, so chunk order can't hide them), foam
  ctx.fillStyle = T.water;
  ctx.beginPath();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (at(x, y) === Ground.Water) ctx.rect(x, y, 1.01, 1.01);
  ctx.fill();
  ctx.strokeStyle = T.waterLight;
  ctx.lineWidth = 2.5 * gpx;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (at(x, y) !== Ground.Water) continue;
      const [wx, wy] = wt(x, y);
      if (hash2(wx, wy, 7) > 0.3) continue;
      ctx.moveTo(x + 0.25, y + 0.55);
      ctx.quadraticCurveTo(x + 0.4, y + 0.4, x + 0.55, y + 0.55);
    }
  }
  ctx.stroke();
  ctx.lineCap = 'butt';
  // A bank face is the land edge dropped by BANK; on the ground plane "down
  // on screen by z" is (+z, +z) in tile coords, so it can be drawn here.
  const B = BANK;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (at(x, y) !== Ground.Water) continue;
      if (at(x, y - 1) !== Ground.Water) {
        ctx.fillStyle = T.bankDark;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 1, y);
        ctx.lineTo(x + 1 + B, y + B);
        ctx.lineTo(x + B, y + B);
        ctx.fill();
      }
      if (at(x - 1, y) !== Ground.Water) {
        ctx.fillStyle = T.bank;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + 1);
        ctx.lineTo(x + B, y + 1 + B);
        ctx.lineTo(x + B, y + B);
        ctx.fill();
      }
    }
  }
  ctx.fillStyle = T.foam;
  ctx.beginPath();
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (at(x, y) !== Ground.Water) continue;
      if (at(x - 1, y) !== Ground.Water) ctx.rect(x + B, y + B, 0.08, 1 - B);
      if (at(x, y - 1) !== Ground.Water) ctx.rect(x + B, y + B, 1 - B, 0.08);
    }
  }
  ctx.fill();

  // Iron ore: dirt patch with outlined nuggets (more nuggets = richer)
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (at(x, y) !== Ground.Ore) continue;
      const [wx, wy] = wt(x, y);
      const n = oreNuggets(world.oreLeft(wx, wy));
      if (n === 0) continue;
      ctx.fillStyle = T.oreGround;
      ctx.fillRect(x, y, 1.01, 1.01);
      for (let k = 0; k < n; k++) {
        const [ox, oy] = rotLocal(rot, 0.22 + hash2(wx, wy, 10 + k) * 0.56, 0.22 + hash2(wx, wy, 20 + k) * 0.56);
        const r = 0.09 + Math.floor(hash2(wx, wy, 30 + k) * 4) * 0.025;
        ctx.fillStyle = T.ore;
        ctx.strokeStyle = T.ink;
        ctx.lineWidth = 1.6 * gpx;
        ctx.beginPath();
        ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = T.oreHi;
        ctx.beginPath();
        ctx.arc(x + ox - r * 0.3, y + oy - r * 0.3, r * 0.38, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  if (scaleCss >= 28) {
    ctx.strokeStyle = T.grid;
    ctx.lineWidth = gpx;
    ctx.beginPath();
    for (let x = x0; x <= x1 + 1; x++) {
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1 + 1);
    }
    for (let y = y0; y <= y1 + 1; y++) {
      ctx.moveTo(x0, y);
      ctx.lineTo(x1 + 1, y);
    }
    ctx.stroke();
  }
}

type Surface = HTMLCanvasElement | OffscreenCanvas;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface Chunk {
  canvas: Surface;
  /** GPU-friendly snapshot of `canvas` (uploaded once, not every frame). */
  image: CanvasImageSource;
  w: number;
  h: number;
  /** Device px per tile it was painted at. */
  scale: number;
  pad: number;
  /** Ore tiles in this chunk and the nugget counts they were painted with. */
  ore: [number, number][];
  oreSig: number;
  used: number;
}

function surface(w: number, h: number): Surface {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export class TerrainCache {
  private world: World | null = null;
  private readonly chunks = new Map<number, Chunk>();
  private frame = 0;
  private lastScale = 0;
  private stillFrames = 0;
  private rot = -1;
  /** Stats for the debug handle. */
  stats = { drawn: 0, painted: 0, cached: 0 };

  /**
   * Blit visible chunks. Returns false when zoomed in past MAX_BUCKET:
   * the caller then paints the (few) visible tiles directly.
   */
  draw(ctx: CanvasRenderingContext2D, world: World, cam: Camera, dpr: number, cssW: number, cssH: number): boolean {
    if (world !== this.world || cam.rot !== this.rot) {
      for (const c of this.chunks.values()) if ('close' in c.image) (c.image as ImageBitmap).close();
      this.chunks.clear();
      this.world = world;
      this.rot = cam.rot;
    }
    this.frame++;
    const dev = cam.scale * dpr;
    if (dev > MAX_DEVICE_SCALE) return false;
    this.stillFrames = dev === this.lastScale ? this.stillFrames + 1 : 0;
    this.lastScale = dev;
    const settled = this.stillFrames >= SETTLE_FRAMES;
    let budget = REPAINT_BUDGET;

    // Chunks live in VIEW space: each one is a screen-aligned diamond.
    const v = cam.visibleView();
    const cx0 = Math.floor(v.x0 / CHUNK);
    const cy0 = Math.floor(v.y0 / CHUNK);
    const cx1 = Math.floor(v.x1 / CHUNK);
    const cy1 = Math.floor(v.y1 / CHUNK);
    const W = cssW * dpr;
    const H = cssH * dpr;
    const checkSig = this.frame % SIG_CHECK_FRAMES === 0;
    let drawn = 0;
    let painted = 0;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Back to front so a chunk's bank overflow lands under its southern neighbour.
    for (let s = cx0 + cy0; s <= cx1 + cy1; s++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const cy = s - cx;
        if (cy < cy0 || cy > cy1) continue;
        // Screen bbox of the chunk diamond (device px), culled against the screen.
        const [tx, ty] = cam.projectView(cx * CHUNK, cy * CHUNK, 0);
        const half = CHUNK * dev * 0.5;
        const left = tx * dpr - half;
        const top = ty * dpr;
        if (left > W || left + 2 * half < 0 || top > H || top + half + dev < 0) continue;

        const id = cx * 65536 + cy;
        let c = this.chunks.get(id);
        if (c && checkSig && c.ore.length && this.oreSig(world, c) !== c.oreSig) c = undefined;
        const stale = c !== undefined && c.scale !== dev;
        // Missing: paint now. Stale (other zoom): keep using it scaled until
        // the zoom settles, then re-paint within the per-frame budget.
        if (!c || (stale && settled && budget > 0)) {
          if (c) budget--;
          c = this.paint(world, cam, cx, cy, dev, dpr, c);
          this.chunks.set(id, c);
          painted++;
        }
        c.used = this.frame;
        const k = dev / c.scale;
        const dx = tx * dpr - (c.pad + (CHUNK * c.scale) / 2) * k;
        const dy = ty * dpr - c.pad * k;
        if (k === 1) {
          // 1:1 on whole pixels: no resampling.
          ctx.drawImage(c.image, Math.round(dx), Math.round(dy));
        } else {
          ctx.drawImage(c.image, dx, dy, c.w * k, c.h * k);
        }
        drawn++;
      }
    }
    this.evict(W * H * 3);
    this.stats = { drawn, painted, cached: this.chunks.size };
    return true;
  }

  private oreSig(world: World, c: Chunk): number {
    let s = 0;
    for (const [x, y] of c.ore) s = (s * 31 + oreNuggets(world.oreLeft(x, y))) | 0;
    return s;
  }

  private paint(world: World, vm: ViewMap, cx: number, cy: number, scale: number, dpr: number, prev?: Chunk): Chunk {
    const S = scale;
    const pad = Math.ceil(S * 0.5);
    const w = Math.ceil(CHUNK * S + 2 * pad);
    const h = Math.ceil((CHUNK * S) / 2 + 2 * pad);
    const canvas = prev && prev.canvas.width === w && prev.canvas.height === h ? prev.canvas : surface(w, h);
    const g = canvas.getContext('2d') as Ctx2D;
    const x0 = cx * CHUNK;
    const y0 = cy * CHUNK;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    // Ground transform with the chunk's top vertex at (pad + CHUNK*S/2, pad).
    g.setTransform(S / 2, S / 4, -S / 2, S / 4, pad + (CHUNK * S) / 2 - ((x0 - y0) * S) / 2, pad - ((x0 + y0) * S) / 4);
    paintTerrain(g, world, x0, y0, x0 + CHUNK - 1, y0 + CHUNK - 1, S / dpr, vm);

    const ore: [number, number][] = prev?.ore ?? [];
    if (!prev) {
      for (let y = y0; y < y0 + CHUNK; y++) {
        for (let x = x0; x < x0 + CHUNK; x++) {
          const [wx, wy] = vm.worldTile(x, y);
          if (world.terrain.at(wx, wy) === Ground.Ore) ore.push([wx, wy]);
        }
      }
    }
    // Snapshot to an ImageBitmap where possible: drawing a live canvas can
    // re-upload it to the GPU every frame; a bitmap is uploaded once.
    if (prev && 'close' in prev.image) (prev.image as ImageBitmap).close();
    const image: CanvasImageSource =
      typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas ? canvas.transferToImageBitmap() : canvas;
    const c: Chunk = { canvas, image, w, h, scale, pad, ore, oreSig: 0, used: this.frame };
    c.oreSig = this.oreSig(world, c);
    return c;
  }

  /** Keep total bitmap pixels under a budget (~3 screens), oldest first. */
  private evict(maxPixels: number): void {
    let total = 0;
    for (const c of this.chunks.values()) total += c.w * c.h;
    if (total <= maxPixels) return;
    const byAge = [...this.chunks].sort((a, b) => a[1].used - b[1].used);
    for (const [id, c] of byAge) {
      if (total <= maxPixels || c.used === this.frame) break;
      total -= c.w * c.h;
      if ('close' in c.image) (c.image as ImageBitmap).close();
      this.chunks.delete(id);
    }
  }
}
