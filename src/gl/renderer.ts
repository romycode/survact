// WebGL2 renderer.
//
// The art is still drawn with the Canvas 2D code (one source of truth for the
// look). What changes is how it reaches the screen:
//
//  - Sprites (buildings in each facing/state, mites in each pose, belt tiles
//    per phase, items, rings, dots…) are painted once into a texture ATLAS at
//    the current zoom, lazily, the first time they're needed.
//  - Every frame is then a handful of instanced draws: each quad is an affine
//    (origin + two axes) so the same path handles upright sprites and
//    ground-plane tiles under any camera angle.
//  - Terrain chunks come from the shared TerrainCache, uploaded once each.
//  - Shadows: one triangle batch with a stencil test, so overlaps never darken twice.
//  - Night: lights accumulate additively into a half-res buffer; one
//    full-screen pass darkens everything that isn't lit.

import type { Camera } from '../camera';
import {
  AIM_STEPS,
  C,
  HEIGHT,
  NO_HOVER,
  SPRITE_TOP,
  TOOL_BUILDING,
  drawBuilding,
  enemyPose,
  furnaceMouth,
  groundArrow,
  isDirected,
  lerp,
  localProj,
  paintBelt,
  paintItem,
  paintMite,
  reachSet,
  turretAim,
  type UiState,
} from '../render';
import { Camera as Cam } from '../camera';
import { BELT_TICKS, BUILDINGS, Building, DAY, TURRET, isBelt } from '../sim/defs';
import { NO_NEXT } from '../sim/flowfield';
import { key, kx, ky, type Tile } from '../sim/grid';
import type { World } from '../sim/world';
import { TerrainCache, type Chunk } from '../terrainLayer';

// ---------------------------------------------------------------- shaders

const SPRITE_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec2 a_org;
layout(location=2) in vec2 a_ax;
layout(location=3) in vec2 a_ay;
layout(location=4) in vec4 a_uv;
layout(location=5) in vec4 a_col;
uniform vec2 u_res;
out vec2 v_uv;
out vec4 v_col;
void main() {
  vec2 p = a_org + a_corner.x * a_ax + a_corner.y * a_ay;
  gl_Position = vec4(p / u_res * 2.0 - 1.0, 0.0, 1.0) * vec4(1.0, -1.0, 1.0, 1.0);
  v_uv = mix(a_uv.xy, a_uv.zw, a_corner);
  v_col = a_col;
}`;

const SPRITE_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
in vec2 v_uv;
in vec4 v_col;
out vec4 o;
void main() { o = texture(u_tex, v_uv) * v_col; }`;

const SOLID_VS = `#version 300 es
layout(location=0) in vec2 a_pos;
uniform vec2 u_res;
void main() { gl_Position = vec4(a_pos / u_res * 2.0 - 1.0, 0.0, 1.0) * vec4(1.0, -1.0, 1.0, 1.0); }`;

const SOLID_FS = `#version 300 es
precision mediump float;
uniform vec4 u_col;
out vec4 o;
void main() { o = u_col; }`;

const DARK_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
out vec2 v_uv;
void main() { v_uv = a_corner; gl_Position = vec4(a_corner * 2.0 - 1.0, 0.0, 1.0); }`;

const DARK_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_light;
uniform vec4 u_dark; // rgb tint, a = darkness amount
in vec2 v_uv;
out vec4 o;
void main() {
  float l = clamp(texture(u_light, v_uv).a, 0.0, 1.0);
  float a = u_dark.a * (1.0 - l);
  o = vec4(u_dark.rgb * a, a);
}`;

// ---------------------------------------------------------------- helpers

type Surface = OffscreenCanvas | HTMLCanvasElement;
function surface(w: number, h: number): Surface {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return Object.assign(document.createElement('canvas'), { width: w, height: h });
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
    gl.attachShader(p, sh);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
  return p;
}

const rgbaCache = new Map<string, [number, number, number, number]>();
/** CSS colour -> premultiplied [r,g,b,a] in 0..1 (parsed once via a 1px canvas). */
function rgba(css: string, alpha = 1): [number, number, number, number] {
  let c = rgbaCache.get(css);
  if (!c) {
    const g = surface(1, 1).getContext('2d') as CanvasRenderingContext2D;
    g.fillStyle = css;
    g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    c = [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255];
    rgbaCache.set(css, c);
  }
  const a = c[3] * alpha;
  return [c[0] * a, c[1] * a, c[2] * a, a];
}
const WHITE: [number, number, number, number] = [1, 1, 1, 1];

// ---------------------------------------------------------------- atlas

interface Sprite {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  w: number;
  h: number;
  /** Anchor inside the sprite (device px of the paint scale). */
  ax: number;
  ay: number;
}

/** Shelf-packed atlas; sprites are painted with Canvas 2D on first use. */
class Atlas {
  readonly tex: WebGLTexture;
  readonly size: number;
  private readonly map = new Map<string, Sprite>();
  private x = 1;
  private y = 1;
  private shelf = 0;
  full = false;
  private readonly gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.size = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.size, this.size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.reset();
  }

  reset(): void {
    this.map.clear();
    this.x = 1;
    this.y = 1;
    this.shelf = 0;
    this.full = false;
  }

  get(id: string, w: number, h: number, ax: number, ay: number, paint: (g: CanvasRenderingContext2D) => void): Sprite {
    let sp = this.map.get(id);
    if (sp) return sp;
    w = Math.max(1, Math.ceil(w));
    h = Math.max(1, Math.ceil(h));
    const pad = 2;
    if (this.x + w + pad > this.size) {
      this.x = 1;
      this.y += this.shelf + pad;
      this.shelf = 0;
    }
    if (this.y + h + pad > this.size) {
      // Out of room: the caller resets the atlas next frame; draw nothing now.
      this.full = true;
      return { u0: 0, v0: 0, u1: 0, v1: 0, w: 0, h: 0, ax: 0, ay: 0 };
    }
    const c = surface(w, h);
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    paint(g);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, this.x, this.y, gl.RGBA, gl.UNSIGNED_BYTE, c as TexImageSource);
    const S = this.size;
    sp = { u0: this.x / S, v0: this.y / S, u1: (this.x + w) / S, v1: (this.y + h) / S, w, h, ax, ay };
    this.map.set(id, sp);
    this.x += w + pad;
    this.shelf = Math.max(this.shelf, h);
    return sp;
  }
}

// ---------------------------------------------------------------- batch

const FLOATS = 14;

class Batch {
  data = new Float32Array(FLOATS * 4096);
  n = 0;

  private grow(): void {
    const d = new Float32Array(this.data.length * 2);
    d.set(this.data);
    this.data = d;
  }

  /** Affine quad: origin + corner.x·ax + corner.y·ay (CSS px). */
  quad(
    ox: number,
    oy: number,
    axx: number,
    axy: number,
    ayx: number,
    ayy: number,
    sp: { u0: number; v0: number; u1: number; v1: number },
    col: [number, number, number, number],
  ): void {
    if ((this.n + 1) * FLOATS > this.data.length) this.grow();
    const d = this.data;
    let i = this.n * FLOATS;
    d[i++] = ox;
    d[i++] = oy;
    d[i++] = axx;
    d[i++] = axy;
    d[i++] = ayx;
    d[i++] = ayy;
    d[i++] = sp.u0;
    d[i++] = sp.v0;
    d[i++] = sp.u1;
    d[i++] = sp.v1;
    d[i++] = col[0];
    d[i++] = col[1];
    d[i++] = col[2];
    d[i++] = col[3];
    this.n++;
  }
}

// ---------------------------------------------------------------- renderer

export class GLRenderer {
  readonly gl: WebGL2RenderingContext;
  private readonly sprite: WebGLProgram;
  private readonly solid: WebGLProgram;
  private readonly darkProg: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly instBuf: WebGLBuffer;
  private readonly solidVao: WebGLVertexArrayObject;
  private readonly solidBuf: WebGLBuffer;
  private readonly quadVao: WebGLVertexArrayObject;
  private readonly atlas: Atlas;
  private readonly batch = new Batch();
  private readonly terrain: TerrainCache;
  private readonly chunkTex = new Map<Chunk, WebGLTexture>();
  private readonly glowTex: WebGLTexture;
  private lightFbo: WebGLFramebuffer | null = null;
  private lightTex: WebGLTexture | null = null;
  private lightW = 0;
  private lightH = 0;
  private readonly uRes: Record<string, WebGLUniformLocation>;
  /** Atlas paint scale (device px per tile), switched when the zoom settles. */
  private S = 0;
  private lastDev = 0;
  private still = 0;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private shadowTris = new Float32Array(6 * 2 * 4 * 512);

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.sprite = compile(gl, SPRITE_VS, SPRITE_FS);
    this.solid = compile(gl, SOLID_VS, SOLID_FS);
    this.darkProg = compile(gl, DARK_VS, DARK_FS);
    this.uRes = {
      sprite: gl.getUniformLocation(this.sprite, 'u_res')!,
      solid: gl.getUniformLocation(this.solid, 'u_res')!,
    };

    const corners = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const cornerBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    const stride = FLOATS * 4;
    const layout: [number, number, number][] = [
      [1, 2, 0],
      [2, 2, 2],
      [3, 2, 4],
      [4, 4, 6],
      [5, 4, 10],
    ];
    for (const [loc, size, off] of layout) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4);
      gl.vertexAttribDivisor(loc, 1);
    }

    this.solidVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.solidVao);
    this.solidBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.solidBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.atlas = new Atlas(gl);
    this.terrain = new TerrainCache({
      keepCanvas: true,
      dispose: (c) => {
        const t = this.chunkTex.get(c);
        if (t) gl.deleteTexture(t);
        this.chunkTex.delete(c);
      },
    });
    this.glowTex = this.makeGlow();
  }

  get stats(): { chunks: unknown; instances: number } {
    return { chunks: this.terrain.stats, instances: this.batch.n };
  }

  // ------------------------------------------------------------ frame

  render(world: World, cam: Camera, ui: UiState, alpha: number, dpr: number, cssW: number, cssH: number): void {
    const gl = this.gl;
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    const W = gl.drawingBufferWidth;
    const H = gl.drawingBufferHeight;
    gl.viewport(0, 0, W, H);

    // Atlas resolution follows the zoom once it settles (crisp at rest).
    const dev = Math.min(cam.scale * dpr, 160);
    this.still = dev === this.lastDev ? this.still + 1 : 0;
    this.lastDev = dev;
    if (this.S === 0 || this.atlas.full || (this.still >= 6 && dev !== this.S)) {
      this.S = dev;
      this.atlas.reset();
    }

    const bg = rgba(C.bg);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // 1. Terrain chunks
    this.drawTerrain(world, cam);

    // 2. Ground overlays (belts, items, routes, plans, reach…)
    const v = cam.visible();
    this.ground(world, cam, ui, v);
    this.flush(this.atlas.tex);

    // 3. Shadows (stencil: each pixel darkened once)
    this.shadows(world, cam, v);

    // 4. Raised things, back to front
    this.raised(world, cam, ui, alpha, v);
    this.flush(this.atlas.tex);

    // 5. Night / golden hour
    this.lighting(world, cam, alpha, v);

    // 6. Shots and bars on top
    this.overlays(world, cam, alpha, v);
    this.flush(this.atlas.tex);
  }

  // ------------------------------------------------------------ passes

  private drawTerrain(world: World, cam: Camera): void {
    const gl = this.gl;
    let m: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
    const dpr = this.dpr;
    this.terrain.drawTo(
      {
        begin: (mm) => (m = mm),
        blit: (c, dx, dy, dw, dh) => {
          let tex = this.chunkTex.get(c);
          if (!tex) {
            tex = gl.createTexture()!;
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c.image as TexImageSource);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            this.chunkTex.set(c, tex);
          }
          // Device-px rect through the layer affine, then to CSS px.
          const [a, b, cc, d, e, f] = m;
          const ox = (a * dx + cc * dy + e) / dpr;
          const oy = (b * dx + d * dy + f) / dpr;
          this.batch.quad(ox, oy, (a * dw) / dpr, (b * dw) / dpr, (cc * dh) / dpr, (d * dh) / dpr, { u0: 0, v0: 0, u1: 1, v1: 1 }, WHITE);
          this.flush(tex);
        },
        end: () => {},
      },
      world,
      cam,
      dpr,
      this.cssW,
      this.cssH,
      Infinity,
    );
  }

  /** A sprite painted in tile space (square texture) mapped onto the ground rect. */
  private groundQuad(cam: Camera, x: number, y: number, w: number, h: number, sp: Sprite, col = WHITE): void {
    const [ox, oy] = cam.project(x, y, 0);
    const [ax, ay] = cam.project(x + w, y, 0);
    const [bx, by] = cam.project(x, y + h, 0);
    this.batch.quad(ox, oy, ax - ox, ay - oy, bx - ox, by - oy, sp, col);
  }

  /** Square tile-space sprite: paint(g) draws in tile units [0..span]². */
  private tileSprite(id: string, span: number, paint: (g: CanvasRenderingContext2D, px: number) => void): Sprite {
    const n = Math.max(4, Math.ceil(this.S * span));
    return this.atlas.get(id, n, n, 0, 0, (g) => {
      g.scale(n / span, n / span);
      paint(g, span / n);
    });
  }

  private white(): Sprite {
    return this.atlas.get('white', 4, 4, 0, 0, (g) => {
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 4, 4);
    });
  }

  /** Inset half a texel so filtering never samples outside the white block. */
  private solidRegion(): Sprite {
    const w = this.white();
    const e = 1 / this.atlas.size;
    return { ...w, u0: w.u0 + e, v0: w.v0 + e, u1: w.u1 - e, v1: w.v1 - e };
  }

  private dot(): Sprite {
    return this.tileSprite('dot', 1, (g) => {
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(0.5, 0.5, 0.48, 0, Math.PI * 2);
      g.fill();
    });
  }

  private ground(world: World, cam: Camera, ui: UiState, v: { x0: number; y0: number; x1: number; y1: number }): void {
    const { grid, terrain } = world;
    const solid = this.solidRegion();

    // Build reach (only with a build tool in hand)
    if (world.phase !== 'lost' && ui.tool !== 'select') {
      const reach = reachSet(world);
      const col = rgba(C.reachTint);
      for (let y = v.y0; y <= v.y1; y++) {
        for (let x = v.x0; x <= v.x1; x++) {
          if (reach.has(key(x, y)) && !terrain.water(x, y)) this.groundQuad(cam, x, y, 1, 1, solid, col);
        }
      }
    }

    // Predicted routes + spawn markers
    if (world.phase !== 'lost') {
      world.syncFlow();
      const seen = new Set<number>();
      for (const s of world.spawns) {
        let k = s;
        for (let guard = 0; k !== NO_NEXT && guard < 5000; guard++) {
          if (seen.has(k)) break;
          seen.add(k);
          k = world.flow.nextKey(k);
        }
      }
      const dot = this.dot();
      const pc = rgba(C.path);
      for (const k of seen) if (k !== world.coreKey) this.groundQuad(cam, kx(k) + 0.4, ky(k) + 0.4, 0.2, 0.2, dot, pc);
      const pulse = 0.5 + 0.5 * Math.sin(world.tickCount / 10);
      const ring = this.tileSprite('spawnring', 1, (g, px) => {
        g.strokeStyle = '#fff';
        g.lineWidth = Math.max(0.06, 3 * px);
        g.beginPath();
        g.arc(0.5, 0.5, 0.42, 0, Math.PI * 2);
        g.stroke();
      });
      const r = 0.38 + pulse * 0.18;
      const sc = rgba(C.spawn);
      for (const k of world.spawns) this.groundQuad(cam, kx(k) + 0.5 - r, ky(k) + 0.5 - r, r * 2, r * 2, ring, sc);
    }

    // Belts and items
    const PH = 8;
    for (const [k, t] of grid.tiles) {
      if (!isBelt(t.b) || !inView(k, v)) continue;
      const period = BELT_TICKS[t.b]!;
      const ph = Math.floor(((world.tickCount % period) / period) * PH);
      const sp = this.tileSprite(`belt|${t.b}|${t.dir}|${ph}`, 1, (g, px) => paintBelt(g, 0, 0, t.b, t.dir, ph / PH, 1.6 * this.dpr * px));
      this.groundQuad(cam, kx(k), ky(k), 1, 1, sp);
    }
    for (const [k, t] of grid.tiles) {
      if (!isBelt(t.b) || !t.item || !inView(k, v)) continue;
      const s = t.prog / BELT_TICKS[t.b]! - 0.5;
      const dx = [1, 0, -1, 0][t.dir];
      const dy = [0, 1, 0, -1][t.dir];
      const cx = kx(k) + 0.5 + dx * s;
      const cy = ky(k) + 0.5 + dy * s;
      const item = t.item;
      const sp = this.tileSprite(`item|${item}`, 0.4, (g, px) => paintItem(g, 0.2, 0.2, item, 1.6 * this.dpr * px));
      this.groundQuad(cam, cx - 0.2, cy - 0.2, 0.4, 0.4, sp);
    }

    // Plans
    const ev = ui.planEval;
    const edge = this.tileSprite('tileedge', 1, (g, px) => {
      g.strokeStyle = '#fff';
      g.lineWidth = Math.max(0.03, 2.5 * px);
      g.strokeRect(0.05, 0.05, 0.9, 0.9);
    });
    const arrows = (d: number) =>
      this.tileSprite(`arrow|${d}`, 1, (g) => groundArrow(g, 0.5, 0.5, d, 0.3, '#fff'));
    const cross = this.tileSprite('cross', 1, (g, px) => {
      g.strokeStyle = '#fff';
      g.lineWidth = Math.max(0.05, 4 * px);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(0.25, 0.25);
      g.lineTo(0.75, 0.75);
      g.moveTo(0.75, 0.25);
      g.lineTo(0.25, 0.75);
      g.stroke();
    });
    for (const [k, p] of ui.plans.map) {
      if (!inView(k, v)) continue;
      const x = kx(k);
      const y = ky(k);
      if (p.kind === 'remove') {
        this.groundQuad(cam, x, y, 1, 1, solid, rgba(C.planBad));
        this.groundQuad(cam, x, y, 1, 1, cross, rgba(C.noAmmo));
        continue;
      }
      const ok = ev?.ok.has(k) ?? false;
      this.groundQuad(cam, x, y, 1, 1, solid, rgba(ok ? C.plan : C.planBad));
      this.groundQuad(cam, x, y, 1, 1, edge, rgba(ok ? C.planEdge : C.noAmmo));
      if (p.kind === 'rotate' || BUILDINGS[p.b].directed) this.groundQuad(cam, x, y, 1, 1, arrows(p.dir), rgba(C.shot));
    }

    // Selection + hover preview
    if (ui.sel && grid.get(key(ui.sel[0], ui.sel[1]))) this.groundQuad(cam, ui.sel[0], ui.sel[1], 1, 1, edge, rgba(C.sel));
    if (world.phase !== 'lost' && ui.hoverX !== NO_HOVER && ui.tool !== 'select') {
      const hx = ui.hoverX;
      const hy = ui.hoverY;
      const b = grid.building(key(hx, hy));
      const ok =
        ui.tool === 'remove'
          ? b !== Building.None && b !== Building.Core
          : world.placeError(hx, hy, TOOL_BUILDING[ui.tool]) === null || isDirected(world, hx, hy);
      this.groundQuad(cam, hx, hy, 1, 1, solid, rgba(ok ? C.ok : C.bad));
      if (ui.tool === 'belt' || ui.tool === 'fastbelt' || ui.tool === 'miner' || ui.tool === 'furnace') {
        this.groundQuad(cam, hx, hy, 1, 1, arrows(ui.dir), rgba(C.shot));
      }
      if (ui.tool === 'turret') {
        const R = TURRET.range;
        const ring = this.tileSprite(`range|${R}`, R * 2, (g, px) => {
          g.strokeStyle = '#fff';
          g.lineWidth = 1.5 * px * 2;
          g.beginPath();
          g.arc(R, R, R - px * 2, 0, Math.PI * 2);
          g.stroke();
        });
        this.groundQuad(cam, hx + 0.5 - R, hy + 0.5 - R, R * 2, R * 2, ring, rgba(C.range));
      }
    }
  }

  private shadows(world: World, cam: Camera, v: { x0: number; y0: number; x1: number; y1: number }): void {
    const light = world.daylight;
    if (light <= 0.02) return;
    const gl = this.gl;
    const t = world.dayPhase;
    const p = Math.min(1, Math.max(0, (t - DAY.dawnEnd * 0.5) / (DAY.nightStart - DAY.dawnEnd)));
    const ang = p * (Math.PI / 2);
    const len = 0.45 + 1.6 * Math.abs(p - 0.5) * 2;
    const sx = Math.cos(ang) * len;
    const sy = Math.sin(ang) * len;
    let n = 0;
    const push = (x: number, y: number) => {
      if (n + 2 > this.shadowTris.length) {
        const d = new Float32Array(this.shadowTris.length * 2);
        d.set(this.shadowTris);
        this.shadowTris = d;
      }
      const [px, py] = cam.project(x, y, 0);
      this.shadowTris[n++] = px;
      this.shadowTris[n++] = py;
    };
    for (const [k, tile] of world.grid.tiles) {
      if (isBelt(tile.b) || !inView(k, v)) continue;
      const h = HEIGHT[tile.b] ?? 0.5;
      const x = kx(k);
      const y = ky(k);
      const a = x + 0.08;
      const b = x + 0.92;
      const c = y + 0.08;
      const d = y + 0.92;
      const u = sx * h;
      const w = sy * h;
      const hex: [number, number][] = [[a, c], [b, c], [b + u, c + w], [b + u, d + w], [a + u, d + w], [a, d]];
      for (let i = 1; i < 5; i++) {
        push(hex[0][0], hex[0][1]);
        push(hex[i][0], hex[i][1]);
        push(hex[i + 1][0], hex[i + 1][1]);
      }
    }
    if (n === 0) return;
    gl.useProgram(this.solid);
    gl.uniform2f(this.uRes.solid, this.cssW, this.cssH);
    gl.uniform4fv(gl.getUniformLocation(this.solid, 'u_col'), rgba('rgb(40,28,14)', 0.26 * light));
    gl.bindVertexArray(this.solidVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.solidBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.shadowTris.subarray(0, n), gl.STREAM_DRAW);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilFunc(gl.EQUAL, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
    gl.drawArrays(gl.TRIANGLES, 0, n / 2);
    gl.disable(gl.STENCIL_TEST);
  }

  private buildingSprite(vt: Tile, aim: number | undefined, variant: string, time: number): Sprite {
    const S = this.S;
    const id = `b|${vt.b}|${vt.dir}|${variant}`;
    const pad = Math.ceil(S * 0.2);
    const w = Math.ceil(S + 2 * pad);
    const h = Math.ceil(S / 2 + (SPRITE_TOP * S) / 2 + 2 * pad);
    const ax = pad + S / 2;
    const ay = pad + (SPRITE_TOP * S) / 2;
    return this.atlas.get(id, w, h, ax, ay, (g) => {
      const sc = new Cam();
      sc.resize(w, h);
      sc.scale = S;
      const c0 = ((h / 2 - ay) * 2) / S;
      sc.centerOn(c0, c0);
      drawBuilding(g, sc, 0, 0, vt, time, aim, false);
    });
  }

  private raised(world: World, cam: Camera, ui: UiState, alpha: number, v: { x0: number; y0: number; x1: number; y1: number }): void {
    for (const sh of world.shots) {
      turretAim.set(key(Math.floor(sh.fromX), Math.floor(sh.fromY)), Math.atan2(sh.toY - sh.fromY, sh.toX - sh.fromX));
    }
    type Item = { depth: number; emit: () => void };
    const list: Item[] = [];
    const k = cam.scale / this.S;
    const time = world.tickCount;

    const emitBuilding = (x: number, y: number, t: Tile, a: number) => {
      const [u, vv] = cam.viewTile(x, y);
      const vt: Tile = BUILDINGS[t.b].directed ? { ...t, dir: cam.viewDir(t.dir) } : t;
      const worldAim = turretAim.get(key(x, y)) ?? Math.PI / 4;
      const viewAim = worldAim + (cam.rot * Math.PI) / 2;
      let aim: number | undefined;
      let variant = '';
      let paintTime = 0;
      if (t.b === Building.Turret) {
        const q = ((Math.round((viewAim / (Math.PI * 2)) * AIM_STEPS) % AIM_STEPS) + AIM_STEPS) % AIM_STEPS;
        aim = (q / AIM_STEPS) * Math.PI * 2;
        variant = `${q}${t.ammo === 0 ? 'e' : ''}`;
      } else if (t.b === Building.Furnace || t.b === Building.Miner) {
        variant = t.cd > 0 ? 'on' : 'off';
      } else if (t.b === Building.Core) {
        // Gem bob baked in 8 phases.
        const q = Math.floor(((time / 28 / (Math.PI * 2)) % 1) * 8);
        variant = `${q}`;
        paintTime = (q / 8) * Math.PI * 2 * 28;
      }
      const sp = this.buildingSprite(vt, aim, variant, paintTime);
      const lp = localProj(cam, x, y, u, vv);
      const [tx, ty] = lp.project(u, vv, 0);
      const col: [number, number, number, number] = [a, a, a, a];
      this.batch.quad(tx - sp.ax * k, ty - sp.ay * k, sp.w * k, 0, 0, sp.h * k, sp, col);
      if (t.b === Building.Furnace && t.cd > 0 && a === 1) {
        const dot = this.dot();
        for (let i = 0; i < 3; i++) {
          const ph = (time / 50 + i / 3) % 1;
          const [sx, sy] = lp.project(u + 0.27 - ph * 0.15, vv + 0.27 - ph * 0.15, 1.3 + ph * 0.7);
          const r = cam.scale * (0.05 + 0.08 * ph);
          this.batch.quad(sx - r, sy - r, r * 2, 0, 0, r * 2, dot, rgba('rgb(200,190,175)', 0.5 * (1 - ph)));
        }
      }
    };

    for (const [kk, t] of world.grid.tiles) {
      if (isBelt(t.b) || !inView(kk, v)) continue;
      const x = kx(kk);
      const y = ky(kk);
      const [u, w] = cam.toView(x + 0.5, y + 0.5);
      list.push({ depth: u + w, emit: () => emitBuilding(x, y, t, 1) });
    }
    const dot = this.dot();
    const shadowCol = rgba(C.shadow);
    for (const e of world.enemies) {
      const ex = lerp(e.prevX, e.x, alpha);
      const ey = lerp(e.prevY, e.y, alpha);
      const [eu, ev] = cam.toView(ex, ey);
      list.push({
        depth: eu + ev,
        emit: () => {
          const s = cam.scale;
          const [gx, gy] = cam.project(ex, ey, 0);
          this.batch.quad(gx - s * 0.17, gy - s * 0.085, s * 0.34, 0, 0, s * 0.17, dot, shadowCol);
          const p = enemyPose(cam, ex, ey, e);
          const hq = Math.round(p.hop * 5);
          const sq = Math.round(Math.abs(p.spin) * 3);
          const lq = ((Math.round((p.look / (Math.PI * 2)) * 8) % 8) + 8) % 8;
          const S = this.S;
          const sw = S * 0.62;
          const sh = S * 0.62;
          const sp = this.atlas.get(`mite|${hq}|${sq}|${lq}`, sw, sh, sw / 2, sh * 0.8, (g) =>
            paintMite(g, sw / 2, sh * 0.8, S, hq / 5, sq / 3, (lq / 8) * Math.PI * 2, Math.max(1.1, S * 0.026)),
          );
          const kk2 = s / S;
          this.batch.quad(gx - sp.ax * kk2, gy - sp.ay * kk2, sp.w * kk2, 0, 0, sp.h * kk2, sp, WHITE);
        },
      });
    }
    for (const [kk, p] of ui.plans.map) {
      if (p.kind !== 'place' || isBelt(p.b) || !inView(kk, v)) continue;
      const x = kx(kk);
      const y = ky(kk);
      const ghost: Tile = { b: p.b, hp: 1, dir: p.dir, cd: 0, ammo: 1, inp: 0, out: 0, item: 0, prog: 0 };
      const ok = ui.planEval?.ok.has(kk) ?? false;
      const [gu, gv] = cam.toView(x + 0.5, y + 0.5);
      list.push({ depth: gu + gv, emit: () => emitBuilding(x, y, ghost, ok ? 0.45 : 0.25) });
    }
    list.sort((a, b) => a.depth - b.depth);
    for (const it of list) it.emit();
  }

  private lighting(world: World, cam: Camera, alpha: number, v: { x0: number; y0: number; x1: number; y1: number }): void {
    const gl = this.gl;
    const light = world.daylight;
    const dark = 1 - light;
    const solid = this.solidRegion();
    const golden = light > 0 && light < 1 ? Math.sin(light * Math.PI) : 0;
    if (golden > 0.01) {
      this.batch.quad(0, 0, this.cssW, 0, 0, this.cssH, solid, rgba('rgb(255,128,48)', 0.16 * golden));
      this.flush(this.atlas.tex);
    }
    if (dark <= 0.01) return;

    // Light sources
    type L = { x: number; y: number; r: number; color: string | null };
    const lights: L[] = [];
    const flicker = 0.92 + 0.08 * Math.sin(world.tickCount * 0.7);
    const lv = { x0: v.x0 - 5, y0: v.y0 - 5, x1: v.x1 + 5, y1: v.y1 + 5 };
    for (const [k, t] of world.grid.tiles) {
      if (!inView(k, lv)) continue;
      const x = kx(k) + 0.5;
      const y = ky(k) + 0.5;
      switch (t.b) {
        case Building.Core:
          lights.push({ x, y, r: 4.8, color: 'rgba(111,224,192,0.10)' });
          break;
        case Building.Turret:
          if (t.ammo > 0) lights.push({ x, y, r: 2.4, color: null });
          break;
        case Building.Furnace:
          lights.push({ x, y, r: t.cd > 0 ? 2.3 * flicker : 1.1, color: t.cd > 0 ? 'rgba(251,146,60,0.16)' : null });
          break;
        case Building.Miner:
          lights.push({ x, y, r: 1.1, color: null });
          break;
      }
    }
    const glowQuad = (l: L, scale: number, col: [number, number, number, number]) => {
      const [sx, sy] = cam.project(l.x, l.y, 0);
      const rx = l.r * scale * cam.scale * 0.707;
      this.batch.quad(sx - rx, sy - rx / 2, rx * 2, 0, 0, rx, { u0: 0, v0: 0, u1: 1, v1: 1 }, col);
    };

    // 1) accumulate light into a half-res buffer
    this.ensureLightFbo();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lightFbo);
    gl.viewport(0, 0, this.lightW, this.lightH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (const l of lights) glowQuad(l, 1, WHITE);
    this.flush(this.glowTex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

    // 2) darken what isn't lit
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.darkProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.lightTex);
    gl.uniform1i(gl.getUniformLocation(this.darkProg, 'u_light'), 0);
    const tint = rgba('rgb(22,16,34)');
    gl.uniform4f(gl.getUniformLocation(this.darkProg, 'u_dark'), tint[0], tint[1], tint[2], 0.74 * dark);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 3) coloured light, additive
    gl.blendFunc(gl.ONE, gl.ONE);
    for (const l of lights) if (l.color) glowQuad(l, 0.8, rgba(l.color, dark));
    this.flush(this.glowTex);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // 4) emissives through the dark: furnace mouths, mite eyes
    const e = Math.min(1, dark * 1.3);
    const k = cam.scale / this.S;
    for (const [kk, t] of world.grid.tiles) {
      if (t.b !== Building.Furnace || t.cd <= 0 || !inView(kk, v)) continue;
      const x = kx(kk);
      const y = ky(kk);
      const [u, w] = cam.viewTile(x, y);
      const vd = cam.viewDir(t.dir);
      const S = this.S;
      const pad = Math.ceil(S * 0.2);
      const sw = Math.ceil(S + 2 * pad);
      const sh = Math.ceil(S / 2 + (SPRITE_TOP * S) / 2 + 2 * pad);
      const ax = pad + S / 2;
      const ay = pad + (SPRITE_TOP * S) / 2;
      const sp = this.atlas.get(`mouth|${vd}`, sw, sh, ax, ay, (g) => {
        const sc = new Cam();
        sc.resize(sw, sh);
        sc.scale = S;
        const c0 = ((sh / 2 - ay) * 2) / S;
        sc.centerOn(c0, c0);
        furnaceMouth(g, sc, 0, 0, { ...t, dir: vd }, C.furnaceHot);
      });
      const [tx, ty] = localProj(cam, x, y, u, w).project(u, w, 0);
      this.batch.quad(tx - sp.ax * k, ty - sp.ay * k, sp.w * k, 0, 0, sp.h * k, sp, [e, e, e, e]);
    }
    const dot = this.dot();
    const eye = Math.max(1.5, cam.scale * 0.03);
    const ec = rgba('#ffe066', e);
    for (const en of world.enemies) {
      const [bx, by] = cam.project(lerp(en.prevX, en.x, alpha), lerp(en.prevY, en.y, alpha), 0.34);
      for (const side of [-1, 1]) this.batch.quad(bx + side * eye * 1.8 - eye, by - eye, eye * 2, 0, 0, eye * 2, dot, ec);
    }
    this.flush(this.atlas.tex);
  }

  private overlays(world: World, cam: Camera, alpha: number, v: { x0: number; y0: number; x1: number; y1: number }): void {
    const solid = this.solidRegion();
    const shot = rgba(C.shot);
    for (const s of world.shots) {
      const [ax, ay] = cam.project(s.fromX, s.fromY, 0.6);
      const [bx, by] = cam.project(s.toX, s.toY, 0.32);
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * 1;
      const ny = (dx / len) * 1;
      this.batch.quad(ax - nx, ay - ny, dx, dy, nx * 2, ny * 2, solid, shot);
    }
    const w = cam.scale * 0.45;
    const bg = rgba(C.hpBg);
    const bar = (x: number, y: number, bw: number, h: number, f: number, col: string) => {
      this.batch.quad(x - 1, y - 1, bw + 2, 0, 0, h + 2, solid, bg);
      this.batch.quad(x, y, Math.max(h, bw * Math.max(0, Math.min(1, f))), 0, 0, h, solid, rgba(col));
    };
    for (const [k, t] of world.grid.tiles) {
      if (!inView(k, v)) continue;
      const max = BUILDINGS[t.b].hp;
      const top = HEIGHT[t.b] ?? 0;
      const [sx, sy] = cam.project(kx(k) + 0.5, ky(k) + 0.5, top);
      if (t.hp < max) bar(sx - w / 2, sy - 12, w, 4, t.hp / max, C.hpFg);
      if (t.b === Building.Turret && t.ammo > 0) bar(sx - w / 2, sy - 7, w, 3, t.ammo / TURRET.maxAmmo, C.turret);
    }
    for (const e of world.enemies) {
      if (e.hp >= e.maxHp) continue;
      const [sx, sy] = cam.project(lerp(e.prevX, e.x, alpha), lerp(e.prevY, e.y, alpha), 0.32);
      bar(sx - w / 2, sy - cam.scale * 0.15 - 8, w, 3, e.hp / e.maxHp, C.hpFg);
    }
  }

  // ------------------------------------------------------------ plumbing

  private flush(tex: WebGLTexture | null): void {
    const b = this.batch;
    if (b.n === 0) return;
    const gl = this.gl;
    gl.useProgram(this.sprite);
    gl.uniform2f(this.uRes.sprite, this.cssW, this.cssH);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, b.data.subarray(0, b.n * FLOATS), gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.n);
    b.n = 0;
  }

  private ensureLightFbo(): void {
    const gl = this.gl;
    const w = Math.max(1, Math.round(gl.drawingBufferWidth / 2));
    const h = Math.max(1, Math.round(gl.drawingBufferHeight / 2));
    if (this.lightFbo && w === this.lightW && h === this.lightH) return;
    if (this.lightTex) gl.deleteTexture(this.lightTex);
    if (this.lightFbo) gl.deleteFramebuffer(this.lightFbo);
    this.lightTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.lightTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.lightFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lightFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.lightTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.lightW = w;
    this.lightH = h;
  }

  private makeGlow(): WebGLTexture {
    const gl = this.gl;
    const n = 128;
    const c = surface(n, n);
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    grad.addColorStop(0, '#fff');
    grad.addColorStop(0.55, '#fff');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, n, n);
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c as TexImageSource);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
}

function inView(k: number, v: { x0: number; y0: number; x1: number; y1: number }): boolean {
  const x = kx(k);
  const y = ky(k);
  return x >= v.x0 && x <= v.x1 && y >= v.y0 && y <= v.y1;
}

