// WebGL2 renderer.
//
// The art is still drawn by the Canvas 2D code in render.ts / terrainLayer.ts
// (one source of truth for the look). WebGL only changes how it reaches the
// screen. What made the first WebGL attempt slower than Canvas 2D on phones,
// and what this one does instead:
//
//  1. Uploads from GPU-backed canvases. Every sprite and terrain chunk was
//     painted into an accelerated (Offscreen)Canvas and uploaded with
//     texSubImage2D, which on mobile means a GPU read-back per upload.
//     → All painting happens in CPU canvases (willReadFrequently), so an
//       upload is a plain memory copy.
//  2. Lazy sprites. Mite poses, belt phases… were painted the first time they
//     showed up, i.e. in bursts right when a wave arrived.
//     → Every sprite variant is baked up front into the atlas.
//  3. Re-baking on zoom. The atlas and the terrain chunks were thrown away and
//     re-painted at the exact zoom every time a pinch settled.
//     → Fixed resolution levels with mipmaps: zooming never repaints. Only
//       crossing a level (×1.5–2) rebuilds, a few ms per frame, double
//       buffered, swapped when complete.
//  4. Fill rate on 3× screens. → Backing store capped at 2× (main.ts).
//
// Plus: projection is done in the vertex shader from world coordinates
// (camera = 3 uniforms), so per-frame CPU work is filling one instance buffer.
//
// Lighting (2.5D): every sprite is baked twice — colour, and a normal map
// painted by the same art code (render.ts normalCtx). The scene is drawn into
// a G-buffer (albedo + normal/height); a full-screen pass then lights it:
// sun by time of day, coloured point lights at night that light the faces
// turned towards them, sun glints on animated water. Baked shading in the art
// is flattened (art.shadeK) so the light supplies the form.

import { DEPTH, RISE, type Camera } from './camera';
import {
  AIM_STEPS,
  C,
  HEIGHT,
  NO_HOVER,
  TOOL_BUILDING,
  aimStep,
  art,
  drawBuilding,
  enemyPose,
  normalCtx,
  groundArrow,
  isDirected,
  lerp,
  lightSources,
  mouthRect,
  paintItem,
  paintMite,
  reachSet,
  routeKeys,
  smokePuff,
  sunVector,
  updateAims,
  type UiState,
  type View,
} from './render';
import { projAt } from './camera';
import { BELT_TICKS, BUILDINGS, Building, Item, TURRET, isBelt } from './sim/defs';
import { key, kx, ky, type Tile } from './sim/grid';
import type { World } from './sim/world';
import { GLTerrain } from './glTerrain';
import { CORE_PHASES, GLStatic, ID, type Sprite } from './glStatic';
import { Shape, beltLooks, beltPoint, itemU } from './belts';

type Ctx2D = CanvasRenderingContext2D;
type RGBA = [number, number, number, number];

// ---------------------------------------------------------------- shaders

const SPRITE_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec3 a_pos;   // world x, y, z
layout(location=2) in vec2 a_off;   // screen offset, in tiles (× scale)
layout(location=3) in vec4 a_axes;  // two screen axes, in tiles (× scale)
layout(location=4) in vec4 a_uv;
layout(location=5) in vec4 a_col;
uniform vec2 u_res;
uniform vec3 u_cam;                 // ox, oy (CSS px), scale (CSS px per tile)
out vec2 v_uv;
out vec4 v_col;
out float v_z;                      // height above ground of this pixel (for lighting)
void main() {
  float s = u_cam.z;
  vec2 base = vec2(u_cam.x + a_pos.x * s, u_cam.y + a_pos.y * s * ${DEPTH.toFixed(4)} - a_pos.z * s * ${RISE.toFixed(4)});
  vec2 p = base + (a_off + a_corner.x * a_axes.xy + a_corner.y * a_axes.zw) * s;
  gl_Position = vec4(p / u_res * 2.0 - 1.0, 0.0, 1.0) * vec4(1.0, -1.0, 1.0, 1.0);
  v_uv = mix(a_uv.xy, a_uv.zw, a_corner);
  v_col = a_col;
  v_z = a_pos.z + (base.y - p.y) / (s * ${RISE.toFixed(4)});
}`;

const SPRITE_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform sampler2D u_ntex;
uniform int u_nmode;   // 0: leave normals, 1: normal atlas, 2: flat ground
in vec2 v_uv;
in vec4 v_col;
in float v_z;
layout(location=0) out vec4 o;
layout(location=1) out vec4 o_n;
void main() {
  o = texture(u_tex, v_uv) * v_col;
  if (u_nmode == 0) { o_n = vec4(0.0); return; }
  vec2 n = vec2(0.0);
  float z = 0.01;
  if (u_nmode == 1) {
    vec4 nn = texture(u_ntex, v_uv);
    if (nn.a > 0.05) n = (nn.rg / nn.a) * 2.0 - 1.0;
    z = clamp(v_z, 0.0, 2.3);
  }
  o_n = vec4(n * 0.5 + 0.5, z / 2.5, 1.0) * o.a;
}`;

// Lighting: albedo × (sun, ambient) + point lights, night tint where unlit.
const MAXL = 24;
const LIGHT_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
void main() { gl_Position = vec4(a_corner * 2.0 - 1.0, 0.0, 1.0); }`;

const LIGHT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_albedo;
uniform sampler2D u_normal;
uniform vec3 u_cam;
uniform vec2 u_res;
uniform float u_dpr;
uniform vec3 u_sun;       // direction towards the sun
uniform vec3 u_sunCol;
uniform float u_amb;
uniform float u_ref;      // normaliser: a flat top at noon = 1
uniform float u_dark;     // 0 day … 1 night
uniform float u_golden;
uniform int u_nl;
uniform vec4 u_lp[${MAXL}];   // x, y, z, radius
uniform vec3 u_lc[${MAXL}];
out vec4 o;
const vec3 VIEW = normalize(vec3(0.0, ${RISE.toFixed(4)}, ${DEPTH.toFixed(4)}));
const vec3 NIGHT = vec3(0.086, 0.063, 0.133);
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  vec3 a = texelFetch(u_albedo, fc, 0).rgb;
  vec4 g = texelFetch(u_normal, fc, 0);
  vec2 nxy = g.rg * 2.0 - 1.0;
  vec3 n = vec3(nxy, sqrt(max(0.0, 1.0 - dot(nxy, nxy))));
  bool water = g.b > 0.98;
  float z = water ? 0.0 : g.b * 2.5;

  // Sun: diffuse + ambient, normalised so a flat top at noon keeps its colour.
  float diff = max(dot(n, u_sun), 0.0);
  vec3 sunL = (vec3(u_amb) + u_sunCol * diff) / u_ref;
  vec3 col = a * sunL;
  // Brass and copper shine: a sun highlight on warm metal (told apart by colour).
  float metal = smoothstep(0.22, 0.42, a.r - a.b) * step(0.04, z);
  vec3 hm = normalize(u_sun + VIEW);
  col += u_sunCol * pow(max(dot(n, hm), 0.0), 32.0) * metal * 0.55;
  if (water) {
    vec3 h = normalize(u_sun + VIEW);
    float sp = pow(max(dot(n, h), 0.0), 90.0);
    col += u_sunCol * sp * 0.55 * (1.0 - u_dark);
  }
  col = mix(col, vec3(1.0, 0.5, 0.19), 0.16 * u_golden);

  if (u_dark > 0.01) {
    vec2 css = vec2(gl_FragCoord.x / u_dpr, u_res.y - gl_FragCoord.y / u_dpr);
    float s = u_cam.z;
    vec3 P = vec3((css.x - u_cam.x) / s, (css.y - u_cam.y + z * s * ${RISE.toFixed(4)}) / (s * ${DEPTH.toFixed(4)}), z);
    vec3 acc = vec3(0.0);
    for (int i = 0; i < ${MAXL}; i++) {
      if (i >= u_nl) break;
      vec3 d = u_lp[i].xyz - P;
      float dist = length(d);
      float att = clamp(1.0 - dist / u_lp[i].w, 0.0, 1.0);
      att *= att;
      acc += u_lc[i] * att * (0.35 + 0.65 * max(dot(n, d / max(dist, 1e-3)), 0.0));
    }
    float lit = clamp(max(acc.r, max(acc.g, acc.b)), 0.0, 1.0);
    col = mix(col, NIGHT, 0.74 * u_dark * (1.0 - lit)) + a * acc * u_dark * 0.85;
  }
  o = vec4(col, 1.0);
}`;

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

// ---------------------------------------------------------------- CPU canvases

type Surface = HTMLCanvasElement | OffscreenCanvas;

/** A canvas the browser keeps in CPU memory: uploading it is a memcpy, not a GPU read-back. */
function cpuCanvas(w: number, h: number): { c: Surface; g: Ctx2D } {
  const c: Surface = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = c.getContext('2d', { willReadFrequently: true }) as Ctx2D;
  return { c, g };
}

// ---------------------------------------------------------------- colours

const rgbaCache = new Map<string, RGBA>();
/** CSS colour (#rgb[a], rgb(), rgba()) -> straight [r,g,b,a] in 0..1, parsed once. */
function parse(css: string): RGBA {
  let c = rgbaCache.get(css);
  if (c) return c;
  const s = css.trim();
  if (s[0] === '#') {
    const h = s.slice(1);
    const full = h.length <= 4 ? [...h].map((ch) => ch + ch).join('') : h;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
    c = [n(0), n(2), n(4), full.length >= 8 ? n(6) : 1];
  } else {
    const m = s.match(/rgba?\(([^)]+)\)/);
    const p = m ? m[1].split(',').map((v) => parseFloat(v)) : [0, 0, 0, 1];
    c = [p[0] / 255, p[1] / 255, p[2] / 255, p[3] ?? 1];
  }
  rgbaCache.set(css, c);
  return c;
}
/** Premultiplied colour with an extra alpha factor. */
function rgba(css: string, alpha = 1): RGBA {
  const c = parse(css);
  const a = c[3] * alpha;
  return [c[0] * a, c[1] * a, c[2] * a, a];
}
const WHITE: RGBA = [1, 1, 1, 1];
const fade = (a: number): RGBA => [a, a, a, a];

// ---------------------------------------------------------------- atlas

interface Job {
  id: number;
  /** px at the bake level */
  w: number;
  h: number;
  /** anchor px inside the sprite */
  ax: number;
  ay: number;
  /** px of one tile in the sprite (usually the level; fixed for level-free sprites) */
  unit: number;
  paint: (g: Ctx2D) => void;
  /** Same drawing into a normal map (lit sprites only). */
  paintN?: (g: Ctx2D) => void;
  x?: number;
  y?: number;
}

/** Sprite resolution levels (device px per tile). Mipmaps cover everything below. */
const SPRITE_LEVELS = [48, 96, 144];
const levelFor = (levels: number[], dev: number) => levels.find((l) => l >= dev * 0.8) ?? levels[levels.length - 1];

const MITE_HOP = 4;
const MITE_SPIN = 2;
const MITE_LOOK = 8;
const PAD = 0.14;
/** Tallest point of each building's silhouette above the ground, in tile heights. */
const TOP: Partial<Record<Building, number>> = {
  [Building.Core]: 1.8,
  [Building.Wall]: 0.72,
  [Building.Miner]: 1.3,
  [Building.Furnace]: 1.5,
  [Building.Turret]: 0.85,
};
const CORE_TIME = (q: number) => (q / CORE_PHASES) * Math.PI * 2 * 28;

function blankTile(b: number, dir: number): Tile {
  return { b, hp: 1, dir, cd: 0, ammo: 1, inp: 0, out: 0, item: 0, prog: 0 } as Tile;
}

/** Paint with flattened baked shading: the lighting pass adds the form. */
function flat(fn: () => void): void {
  const k = art.shadeK;
  art.shadeK = 0.35;
  try {
    fn();
  } finally {
    art.shadeK = k;
  }
}

/** Every sprite the game can show, at level S (device px per tile). */
function spriteJobs(S: number, dpr: number): Job[] {
  const jobs: Job[] = [];
  const ink = Math.max(1.1, S * 0.026);
  const gpx = dpr / S; // ~1 CSS px at this level, in ground units

  const building = (id: number, b: Building, t: Tile, time: number, aim?: number) => {
    const top = TOP[b] ?? 1;
    const w = Math.ceil(S * (1 + 2 * PAD));
    const h = Math.ceil(S * (DEPTH + top * RISE + 2 * PAD));
    const ax = PAD * S;
    const ay = (PAD + top * RISE) * S;
    jobs.push({
      id,
      w,
      h,
      ax,
      ay,
      unit: S,
      paint: (g) => flat(() => drawBuilding(g, projAt(S, ax, ay), 0, 0, t, time, aim, false)),
      paintN: (g) => drawBuilding(normalCtx(g), projAt(S, ax, ay), 0, 0, t, time, aim, false),
    });
  };
  for (let q = 0; q < CORE_PHASES; q++) building(ID.building(Building.Core, 0, q), Building.Core, blankTile(Building.Core, 0), CORE_TIME(q));
  building(ID.building(Building.Wall, 0, 0), Building.Wall, blankTile(Building.Wall, 0), 0);
  for (let d = 0; d < 4; d++) {
    for (const on of [0, 1]) {
      for (const b of [Building.Miner, Building.Furnace] as const) {
        const t = blankTile(b, d);
        t.cd = on;
        building(ID.building(b, d, on), b, t, 0);
      }
    }
  }
  for (let q = 0; q < AIM_STEPS; q++) {
    for (const empty of [0, 1]) {
      const t = blankTile(Building.Turret, 0);
      t.ammo = empty ? 0 : 1;
      building(ID.building(Building.Turret, 0, q + empty * AIM_STEPS), Building.Turret, t, 0, (q / AIM_STEPS) * Math.PI * 2);
    }
  }

  // Wind-up mites: hop × key spin × look direction.
  const mw = Math.ceil(S * 0.56);
  const mh = Math.ceil(S * 0.66);
  const max = S * 0.28;
  const may = S * 0.58;
  for (let hq = 0; hq <= MITE_HOP; hq++) {
    for (let sq = 0; sq <= MITE_SPIN; sq++) {
      for (let lq = 0; lq < MITE_LOOK; lq++) {
        jobs.push({
          id: ID.mite(hq, sq, lq),
          w: mw,
          h: mh,
          ax: max,
          ay: may,
          unit: S,
          paint: (g) => flat(() => paintMite(g, max, may, S, hq / MITE_HOP, sq / MITE_SPIN, (lq / MITE_LOOK) * Math.PI * 2, ink)),
          paintN: (g) => paintMite(normalCtx(g), max, may, S, hq / MITE_HOP, sq / MITE_SPIN, (lq / MITE_LOOK) * Math.PI * 2, ink),
        });
      }
    }
  }

  // Ground sprites are baked already squashed (S × S·DEPTH per tile).
  const ground = (id: number, span: number, paint: (g: Ctx2D) => void) => {
    jobs.push({
      id,
      w: Math.ceil(S * span),
      h: Math.ceil(S * span * DEPTH),
      ax: 0,
      ay: 0,
      unit: S,
      paint: (g) => {
        g.setTransform(S, 0, 0, S * DEPTH, 0, 0);
        paint(g);
      },
    });
  };
  for (const it of [Item.Iron, Item.Plate]) ground(ID.item(it), 0.4, (g) => paintItem(g, 0.2, 0.2, it, 1.6 * 2 * gpx));
  ground(ID.edge, 1, (g) => {
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5 * 2 * gpx;
    g.strokeRect(0.04, 0.04, 0.92, 0.92);
  });
  ground(ID.edgeSel, 1, (g) => {
    g.strokeStyle = '#fff';
    g.lineWidth = 2.5 * 2 * gpx;
    g.strokeRect(0.03, 0.03, 0.94, 0.94);
  });
  ground(ID.cross, 1, (g) => {
    g.strokeStyle = '#fff';
    g.lineWidth = 3 * 2 * gpx;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(0.25, 0.25);
    g.lineTo(0.75, 0.75);
    g.moveTo(0.75, 0.25);
    g.lineTo(0.25, 0.75);
    g.stroke();
  });
  for (let d = 0; d < 4; d++) ground(ID.arrow(d), 1, (g) => groundArrow(g, 0.5, 0.5, d, 0.3, '#fff'));

  // Level-free helpers: a white block and a soft-edged dot (64 px).
  jobs.push({
    id: ID.white,
    w: 8,
    h: 8,
    ax: 0,
    ay: 0,
    unit: 8,
    paint: (g) => {
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 8, 8);
    },
  });
  jobs.push({
    id: ID.dot,
    w: 64,
    h: 64,
    ax: 0,
    ay: 0,
    unit: 64,
    paint: (g) => {
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(32, 32, 31, 0, Math.PI * 2);
      g.fill();
    },
  });
  return jobs;
}

const GAP = 4;

/**
 * Atlas baked from a job list, possibly over several frames (step()).
 * Until `ready`, the previous atlas keeps drawing.
 */
class AtlasBuild {
  readonly tex: WebGLTexture;
  readonly ntex: WebGLTexture;
  readonly W: number;
  readonly H: number;
  readonly S: number;
  readonly map = new Map<number, Sprite>();
  ready = false;
  private i = 0;
  private readonly jobs: Job[];
  private scratch: { c: Surface; g: Ctx2D } | null = null;
  private readonly gl: WebGL2RenderingContext;

  /** Throws if the jobs don't fit the max texture size. */
  constructor(gl: WebGL2RenderingContext, S: number, dpr: number) {
    this.gl = gl;
    this.S = S;
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const jobs = spriteJobs(S, dpr).sort((a, b) => b.h - a.h);
    let area = 0;
    for (const j of jobs) area += (j.w + GAP) * (j.h + GAP);
    const W = Math.min(maxTex, area > 2048 * 2048 * 0.75 ? 4096 : 2048);
    // Shelf packing, tallest first.
    let x = GAP;
    let y = GAP;
    let shelf = 0;
    for (const j of jobs) {
      if (x + j.w + GAP > W) {
        x = GAP;
        y += shelf + GAP;
        shelf = 0;
      }
      j.x = x;
      j.y = y;
      x += j.w + GAP;
      shelf = Math.max(shelf, j.h);
    }
    const H = y + shelf + GAP;
    if (H > maxTex) throw new Error('atlas too big');
    this.W = W;
    this.H = H;
    this.jobs = jobs;
    const mk = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 3, gl.RGBA8, W, H);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 2);
      // Clear to transparent (texStorage content is undefined until written).
      const zero = new Uint8Array(W * 64 * 4);
      for (let yy = 0; yy < H; yy += 64) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, yy, W, Math.min(64, H - yy), gl.RGBA, gl.UNSIGNED_BYTE, zero);
      return t;
    };
    this.tex = mk();
    this.ntex = mk();
  }

  get progress(): number {
    return this.i / this.jobs.length;
  }

  /** Bake jobs for up to `budgetMs`. Returns true when the atlas is complete. */
  step(budgetMs: number): boolean {
    if (this.ready) return true;
    const gl = this.gl;
    const t0 = performance.now();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    while (this.i < this.jobs.length) {
      const j = this.jobs[this.i++];
      if (!this.scratch || this.scratch.c.width < j.w || this.scratch.c.height < j.h) {
        this.scratch = cpuCanvas(Math.max(j.w, this.scratch?.c.width ?? 0), Math.max(j.h, this.scratch?.c.height ?? 0));
      }
      const g = this.scratch.g;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.clearRect(0, 0, j.w, j.h);
      g.save();
      j.paint(g);
      g.restore();
      const img = g.getImageData(0, 0, j.w, j.h);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, j.x!, j.y!, gl.RGBA, gl.UNSIGNED_BYTE, img);
      if (j.paintN) {
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, j.w, j.h);
        g.save();
        j.paintN(g);
        g.restore();
        gl.bindTexture(gl.TEXTURE_2D, this.ntex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, j.x!, j.y!, gl.RGBA, gl.UNSIGNED_BYTE, g.getImageData(0, 0, j.w, j.h));
      }
      const inset = j.id === ID.white ? 3 : 0; // sample the middle of the white block
      this.map.set(j.id, {
        u0: (j.x! + inset) / this.W,
        v0: (j.y! + inset) / this.H,
        u1: (j.x! + j.w - inset) / this.W,
        v1: (j.y! + j.h - inset) / this.H,
        dx: -j.ax / j.unit,
        dy: -j.ay / j.unit,
        w: j.w / j.unit,
        h: j.h / j.unit,
      });
      if (performance.now() - t0 > budgetMs) break;
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (this.i < this.jobs.length) return false;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, this.ntex);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.scratch = null;
    this.ready = true;
    return true;
  }

  dispose(): void {
    this.gl.deleteTexture(this.tex);
    this.gl.deleteTexture(this.ntex);
  }
}

// ---------------------------------------------------------------- batch

const FLOATS = 17;

class Batch {
  data = new Float32Array(FLOATS * 4096);
  n = 0;

  /** World point (x, y, z) + screen offset/axes in tiles (× scale). */
  push(x: number, y: number, z: number, dx: number, dy: number, axx: number, axy: number, ayx: number, ayy: number, sp: Sprite, col: RGBA): void {
    if ((this.n + 1) * FLOATS > this.data.length) {
      const d = new Float32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    const d = this.data;
    let i = this.n * FLOATS;
    d[i++] = x;
    d[i++] = y;
    d[i++] = z;
    d[i++] = dx;
    d[i++] = dy;
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
  private readonly lightProg: WebGLProgram;
  private readonly u: Record<string, WebGLUniformLocation | null> = {};
  private readonly vao: WebGLVertexArrayObject;
  private readonly instBuf: WebGLBuffer;
  private readonly quadVao: WebGLVertexArrayObject;
  private readonly batch = new Batch();
  private atlas: AtlasBuild;
  private next: AtlasBuild | null = null;
  private readonly terrain: GLTerrain;
  private readonly statics: GLStatic;
  private readonly glowTex: WebGLTexture;
  /** G-buffer: albedo + (normal.xy, height) with depth/stencil, at drawing-buffer size. */
  private gb: { fbo: WebGLFramebuffer; albedo: WebGLTexture; normal: WebGLTexture; ds: WebGLRenderbuffer; w: number; h: number } | null = null;
  private cam!: Camera;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private lastDev = 0;
  private still = 0;

  constructor(gl: WebGL2RenderingContext, dpr: number, initialDev: number) {
    this.gl = gl;
    this.dpr = dpr;
    this.sprite = compile(gl, SPRITE_VS, SPRITE_FS);
    this.lightProg = compile(gl, LIGHT_VS, LIGHT_FS);
    for (const n of ['u_res', 'u_cam', 'u_tex', 'u_ntex', 'u_nmode']) this.u['s' + n] = gl.getUniformLocation(this.sprite, n);
    for (const n of ['u_albedo', 'u_normal', 'u_cam', 'u_res', 'u_dpr', 'u_sun', 'u_sunCol', 'u_amb', 'u_ref', 'u_dark', 'u_golden', 'u_nl', 'u_lp', 'u_lc']) {
      this.u['l' + n] = gl.getUniformLocation(this.lightProg, n);
    }

    const cornerBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    const stride = FLOATS * 4;
    const layout: [number, number, number][] = [
      [1, 3, 0],
      [2, 2, 3],
      [3, 4, 5],
      [4, 4, 9],
      [5, 4, 13],
    ];
    for (const [loc, size, off] of layout) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4);
      gl.vertexAttribDivisor(loc, 1);
    }

    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // First atlas: baked synchronously (it's the loading screen's job).
    this.atlas = this.makeAtlas(levelFor(SPRITE_LEVELS, initialDev));
    this.atlas.step(Infinity);
    this.atlasWant = levelFor(SPRITE_LEVELS, initialDev);
    this.terrain = new GLTerrain(gl);
    this.statics = new GLStatic(gl, cornerBuf);
    this.statics.setAtlas(this.atlas.map);
    this.glowTex = this.makeGlow();
  }

  /** Atlas at level S, stepping down a level if it doesn't fit the GPU's max texture size. */
  private makeAtlas(S: number): AtlasBuild {
    for (let i = SPRITE_LEVELS.indexOf(S); i >= 0; i--) {
      try {
        return new AtlasBuild(this.gl, SPRITE_LEVELS[i], this.dpr);
      } catch {
        /* try the next level down */
      }
    }
    return new AtlasBuild(this.gl, SPRITE_LEVELS[0], this.dpr);
  }

  get stats(): unknown {
    return {
      atlas: { level: this.atlas.S, size: `${this.atlas.W}x${this.atlas.H}`, rebuilding: this.next ? Math.round(this.next.progress * 100) : null },
      terrain: this.terrain.stats,
      instances: this.batch.n,
    };
  }

  private sp(id: number): Sprite {
    return this.atlas.map.get(id)!;
  }

  // ------------------------------------------------------------ frame

  render(world: World, cam: Camera, ui: UiState, alpha: number, dpr: number, cssW: number, cssH: number): void {
    const gl = this.gl;
    this.cam = cam;
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

    // Resolution levels follow the zoom only once it has settled; the swap is double buffered.
    const dev = cam.scale * dpr;
    this.still = dev === this.lastDev ? this.still + 1 : 0;
    this.lastDev = dev;
    const settled = this.still >= 20;
    const wantS = levelFor(SPRITE_LEVELS, dev);
    if (settled && !this.next && wantS !== this.atlasWant) {
      this.atlasWant = wantS;
      const next = this.makeAtlas(wantS);
      if (next.S === this.atlas.S) next.dispose(); // doesn't fit: stay where we are
      else this.next = next;
    }
    if (this.next && this.next.step(4)) {
      this.atlas.dispose();
      this.atlas = this.next;
      this.next = null;
      this.statics.setAtlas(this.atlas.map);
    }

    // 1. Scene into the G-buffer (albedo + normal/height)
    const gb = this.ensureGBuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, gb.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    const bg = parse(C.bg);
    gl.clearBufferfv(gl.COLOR, 0, [bg[0], bg[1], bg[2], 1]);
    gl.clearBufferfv(gl.COLOR, 1, [0.5, 0.5, 0, 1]);
    gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const v = cam.visible();
    updateAims(world);
    this.statics.sync(world);
    this.statics.updateState(world.tickCount);
    this.drawTerrain(world, cam);
    this.ground(world, ui, v);
    this.flush(this.atlas.tex);
    this.shadows(world);
    this.raised(world, ui, alpha, v);
    this.flush(this.atlas.tex);

    // 2. Light it onto the screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.lighting(world, v);

    // 3. Unlit things on top: emissive glows, eyes, shots, bars
    this.emissive(world, alpha, v);
    this.overlays(world, alpha, v);
    this.flush(this.atlas.tex);
  }

  private atlasWant = 0;

  // ------------------------------------------------------------ helpers

  /** Ground rect (tile units), squashed like the ground. */
  private groundQuad(x: number, y: number, w: number, h: number, sp: Sprite, col: RGBA = WHITE): void {
    this.batch.push(x, y, 0, 0, 0, w, 0, 0, h * DEPTH, sp, col);
  }

  /** A quad given in screen CSS px (origin + two axes). */
  private screenQuad(px: number, py: number, axx: number, axy: number, ayx: number, ayy: number, sp: Sprite, col: RGBA): void {
    const cam = this.cam;
    const s = cam.scale;
    const [wx, wy] = cam.toWorld(px, py);
    this.batch.push(wx, wy, 0, 0, 0, axx / s, axy / s, ayx / s, ayy / s, sp, col);
  }

  /** Straight line between two screen points, `width` CSS px thick. */
  private line(ax: number, ay: number, bx: number, by: number, width: number, col: RGBA): void {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (width / 2);
    const ny = (dx / len) * (width / 2);
    this.screenQuad(ax - nx, ay - ny, dx, dy, nx * 2, ny * 2, this.sp(ID.white), col);
  }

  /** Circle on the ground (an ellipse on screen) drawn as segments. */
  private groundRing(cx: number, cy: number, r: number, width: number, col: RGBA, seg = 48): void {
    const cam = this.cam;
    let [px, py] = cam.project(cx + r, cy, 0);
    for (let i = 1; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const [qx, qy] = cam.project(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0);
      this.line(px, py, qx, qy, width, col);
      px = qx;
      py = qy;
    }
  }

  // ------------------------------------------------------------ passes

  private drawTerrain(world: World, cam: Camera): void {
    this.terrain.draw(world, cam, this.quadVao, this.dpr, this.cssW, this.cssH, world.tickCount / 60);
  }

  private ground(world: World, ui: UiState, v: View): void {
    const { grid, terrain } = world;
    const white = this.sp(ID.white);

    if (world.phase !== 'lost' && ui.tool !== 'select') {
      const reach = reachSet(world);
      const col = rgba(C.reachTint);
      for (let y = v.y0; y <= v.y1; y++) {
        for (let x = v.x0; x <= v.x1; x++) if (reach.has(key(x, y)) && !terrain.water(x, y)) this.groundQuad(x, y, 1, 1, white, col);
      }
    }

    if (world.phase !== 'lost') {
      const dot = this.sp(ID.dot);
      const pc = rgba(C.path);
      for (const k of routeKeys(world)) if (k !== world.coreKey) this.groundQuad(kx(k) + 0.4, ky(k) + 0.4, 0.2, 0.2, dot, pc);
      const pulse = 0.5 + 0.5 * Math.sin(world.tickCount / 10);
      const sc = rgba(C.spawn);
      for (const k of world.spawns) this.groundRing(kx(k) + 0.5, ky(k) + 0.5, 0.3 + pulse * 0.15, 2 + pulse * 2, sc, 24);
    }

    // Belts: static instances, drawn as continuous lines by their own shader.
    this.flush(this.atlas.tex);
    const ph = (b: Building) => (world.tickCount % BELT_TICKS[b]!) / BELT_TICKS[b]!;
    this.statics.drawBelts(this.cam, this.cssW, this.cssH, this.dpr, [ph(Building.Belt), ph(Building.FastBelt)]);
    const looks = beltLooks(world);
    for (const [k, t] of grid.tiles) {
      if (!isBelt(t.b) || !t.item || !inView(k, v)) continue;
      const [ix, iy] = beltPoint(kx(k), ky(k), t.dir, looks.get(k)?.shape ?? Shape.Straight, itemU(looks.get(k), t.prog / BELT_TICKS[t.b]!));
      const sp = this.sp(ID.item(t.item));
      this.batch.push(ix, iy, 0, sp.dx - 0.2, sp.dy - 0.2 * DEPTH, sp.w, 0, 0, sp.h, sp, WHITE);
    }
    this.flush(this.atlas.tex, 2);

    const ev = ui.planEval;
    for (const [k, p] of ui.plans.map) {
      if (!inView(k, v)) continue;
      const x = kx(k);
      const y = ky(k);
      if (p.kind === 'remove') {
        this.groundQuad(x, y, 1, 1, white, rgba(C.planBad));
        this.groundQuad(x, y, 1, 1, this.sp(ID.cross), rgba(C.noAmmo));
        continue;
      }
      const ok = ev?.ok.has(k) ?? false;
      this.groundQuad(x, y, 1, 1, white, rgba(ok ? C.plan : C.planBad));
      this.groundQuad(x, y, 1, 1, this.sp(ID.edge), rgba(ok ? C.planEdge : C.noAmmo));
      if (p.kind === 'rotate' || BUILDINGS[p.b].directed) this.groundQuad(x, y, 1, 1, this.sp(ID.arrow(p.dir)), rgba(C.shot));
    }

    if (ui.sel && grid.get(key(ui.sel[0], ui.sel[1]))) this.groundQuad(ui.sel[0], ui.sel[1], 1, 1, this.sp(ID.edgeSel), rgba(C.sel));
    if (world.phase !== 'lost' && ui.hoverX !== NO_HOVER && ui.tool !== 'select') {
      const hx = ui.hoverX;
      const hy = ui.hoverY;
      const b = grid.building(key(hx, hy));
      const ok =
        ui.tool === 'remove'
          ? b !== Building.None && b !== Building.Core
          : world.placeError(hx, hy, TOOL_BUILDING[ui.tool]) === null || isDirected(world, hx, hy);
      this.groundQuad(hx, hy, 1, 1, white, rgba(ok ? C.ok : C.bad));
      if (ui.tool === 'belt' || ui.tool === 'fastbelt' || ui.tool === 'miner' || ui.tool === 'furnace') {
        this.groundQuad(hx, hy, 1, 1, this.sp(ID.arrow(ui.dir)), rgba(C.shot));
      }
      if (ui.tool === 'turret') this.groundRing(hx + 0.5, hy + 0.5, TURRET.range, 1.5, rgba(C.range), 96);
    }
  }

  private shadows(world: World): void {
    const light = world.daylight;
    this.statics.drawAO(this.cam, this.cssW, this.cssH);
    if (light <= 0.02) return;
    this.statics.drawShadows(this.cam, this.cssW, this.cssH, sunVector(world), rgba('rgb(40,28,14)', 0.26 * light));
  }

  private building(x: number, y: number, t: Tile, a: number, time: number): void {
    let id: number;
    switch (t.b) {
      case Building.Core:
        id = ID.building(Building.Core, 0, Math.floor(((time / 28 / (Math.PI * 2)) % 1) * CORE_PHASES));
        break;
      case Building.Turret:
        id = ID.building(Building.Turret, 0, aimStep(x, y) + (t.ammo === 0 ? AIM_STEPS : 0));
        break;
      case Building.Miner:
      case Building.Furnace:
        id = ID.building(t.b, t.dir, t.cd > 0 ? 1 : 0);
        break;
      default:
        id = ID.building(t.b, 0, 0);
    }
    const sp = this.sp(id);
    if (!sp) return;
    this.batch.push(x, y, 0, sp.dx, sp.dy, sp.w, 0, 0, sp.h, sp, a === 1 ? WHITE : fade(a));
  }

  /**
   * Buildings come from the static buffer (sorted north→south); enemies and
   * plan ghosts are dynamic. Interleave them by depth: draw the static range
   * up to each dynamic item, then the item.
   */
  private raised(world: World, ui: UiState, alpha: number, v: View): void {
    const cam = this.cam;
    const st = this.statics;
    type Dyn = { d: number; x: number; y: number; e?: (typeof world.enemies)[number]; t?: Tile; a: number };
    const dyn: Dyn[] = [];
    for (const e of world.enemies) {
      const ex = lerp(e.prevX, e.x, alpha);
      const ey = lerp(e.prevY, e.y, alpha);
      if (ex < v.x0 - 1 || ex > v.x1 + 1 || ey < v.y0 - 1 || ey > v.y1 + 1) continue;
      dyn.push({ d: ey + 0.5 + ex * 1e-4, x: ex, y: ey, e, a: 1 });
    }
    for (const [k, p] of ui.plans.map) {
      if (p.kind !== 'place' || isBelt(p.b) || !inView(k, v)) continue;
      const x = kx(k);
      const y = ky(k);
      const ok = ui.planEval?.ok.has(k) ?? false;
      dyn.push({ d: y + 1 + x * 1e-4, x, y, t: blankTile(p.b, p.dir), a: ok ? 0.45 : 0.25 });
    }
    dyn.sort((a, b) => a.d - b.d);

    const [i0, i1] = st.range(v.y0 - 1, v.y1);
    let i = i0;
    const dot = this.sp(ID.dot);
    const shadowCol = rgba(C.shadow);
    for (const it of dyn) {
      let j = i;
      while (j < i1 && st.depth(j) < it.d) j++;
      if (j > i) {
        this.flush(this.atlas.tex, 1);
        st.drawBuildings(i, j, cam, this.cssW, this.cssH, this.atlas.tex, this.atlas.ntex);
        i = j;
      }
      if (it.e) {
        // Contact shadow goes in unlit (it only darkens the albedo).
        this.flush(this.atlas.tex, 1);
        this.batch.push(it.x, it.y, 0, -0.17, -0.085, 0.34, 0, 0, 0.17, dot, shadowCol);
        this.flush(this.atlas.tex, 0);
        const p = enemyPose(cam, it.x, it.y, it.e);
        const hq = Math.round(p.hop * MITE_HOP);
        const sq = Math.round(Math.abs(p.spin) * MITE_SPIN);
        const lq = ((Math.round((p.look / (Math.PI * 2)) * MITE_LOOK) % MITE_LOOK) + MITE_LOOK) % MITE_LOOK;
        const sp = this.sp(ID.mite(hq, sq, lq));
        this.batch.push(it.x, it.y, 0, sp.dx, sp.dy, sp.w, 0, 0, sp.h, sp, WHITE);
      } else {
        this.building(it.x, it.y, it.t!, it.a, 0);
      }
    }
    this.flush(this.atlas.tex, 1);
    st.drawBuildings(i, i1, cam, this.cssW, this.cssH, this.atlas.tex, this.atlas.ntex);

    // Furnace smoke rises above everything around it.
    for (let n = i0; n < i1; n++) {
      const t = st.tiles[n];
      if (t.b !== Building.Furnace || t.cd <= 0) continue;
      for (let q = 0; q < 3; q++) {
        const [px, py, pz, r, pa] = smokePuff(st.xs[n], st.ys[n], world.tickCount, q);
        this.batch.push(px, py, pz, -r, -r, r * 2, 0, 0, r * 2, dot, rgba('rgb(200,190,175)', pa));
      }
    }
  }

  /** Full-screen lighting pass: G-buffer -> screen. */
  private lighting(world: World, v: View): void {
    const gl = this.gl;
    const gb = this.gb!;
    const light = world.daylight;
    const dark = 1 - light;
    const golden = light > 0 && light < 1 ? Math.sin(light * Math.PI) : 0;
    // Towards the sun: opposite to where shadows fall, higher when they're short.
    const [sx, sy] = sunVector(world);
    const l = Math.hypot(sx, sy, 1);
    const sun = [-sx / l, -sy / l, 1 / l];
    const warm = golden * 0.6;
    const sunK = 0.55 * light;
    const sunCol = [sunK, sunK * (1 - 0.3 * warm), sunK * (1 - 0.55 * warm)];
    const amb = 0.7;
    const ref = amb + 0.55 * 0.92;

    gl.disable(gl.BLEND);
    gl.useProgram(this.lightProg);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, gb.albedo);
    gl.uniform1i(this.u.lu_albedo!, 5);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, gb.normal);
    gl.uniform1i(this.u.lu_normal!, 6);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform3f(this.u.lu_cam!, this.cam.ox, this.cam.oy, this.cam.scale);
    gl.uniform2f(this.u.lu_res!, this.cssW, this.cssH);
    gl.uniform1f(this.u.lu_dpr!, this.dpr);
    gl.uniform3fv(this.u.lu_sun!, sun);
    gl.uniform3fv(this.u.lu_sunCol!, sunCol);
    gl.uniform1f(this.u.lu_amb!, amb);
    gl.uniform1f(this.u.lu_ref!, ref);
    gl.uniform1f(this.u.lu_dark!, dark);
    gl.uniform1f(this.u.lu_golden!, golden);

    let nl = 0;
    if (dark > 0.01) {
      const lights = lightSources(world, v);
      // Nearest to the screen centre first.
      const [cx, cy] = this.cam.toWorld(this.cssW / 2, this.cssH / 2);
      lights.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
      const lp = new Float32Array(MAXL * 4);
      const lc = new Float32Array(MAXL * 3);
      for (const L of lights) {
        if (nl >= MAXL) break;
        const [z, col] = lightLook(L.b, L.on);
        lp.set([L.x, L.y, z, L.r * 1.5], nl * 4);
        lc.set(col, nl * 3);
        nl++;
      }
      gl.uniform4fv(this.u.lu_lp!, lp);
      gl.uniform3fv(this.u.lu_lc!, lc);
    }
    gl.uniform1i(this.u.lu_nl!, nl);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** After lighting: soft glows (cheap bloom), furnace mouths and mite eyes through the dark. */
  private emissive(world: World, alpha: number, v: View): void {
    const gl = this.gl;
    const cam = this.cam;
    const dark = 1 - world.daylight;
    const white = this.sp(ID.white);
    // Furnace mouths glow at any hour (they're fire, not lit surfaces).
    const hot = rgba(C.furnaceHot);
    for (const [k, t] of world.grid.tiles) {
      if (t.b !== Building.Furnace || t.cd <= 0 || !inView(k, v)) continue;
      const m = mouthRect(kx(k), ky(k), t.dir);
      if (m.top) this.batch.push(m.a, m.c, m.e, 0, 0, m.b - m.a, 0, 0, (m.d - m.c) * DEPTH, white, hot);
      else this.batch.push(m.a, m.c, m.e, 0, 0, m.b - m.a, 0, 0, (m.e - m.d) * RISE, white, hot);
    }
    this.flush(this.atlas.tex);
    if (dark <= 0.01) return;
    const e = Math.min(1, dark * 1.3);
    const full = { u0: 0, v0: 0, u1: 1, v1: 1, dx: 0, dy: 0, w: 0, h: 0 };
    const halo = (x: number, y: number, z: number, r: number, col: RGBA) => this.batch.push(x, y, z, -r, -r, r * 2, 0, 0, r * 2, full, col);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (const [k, t] of world.grid.tiles) {
      if (!inView(k, v)) continue;
      const x = kx(k) + 0.5;
      const y = ky(k) + 0.5;
      if (t.b === Building.Core) halo(x, y, 1.35, 0.75, rgba('rgb(111,224,192)', 0.35 * dark));
      else if (t.b === Building.Furnace && t.cd > 0) {
        const m = mouthRect(kx(k), ky(k), t.dir);
        halo((m.a + m.b) / 2, m.c, m.top ? m.e : (m.d + m.e) / 2, 0.45, rgba('rgb(255,150,60)', 0.45 * dark));
      }
    }
    this.flush(this.glowTex);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const dot = this.sp(ID.dot);
    const eye = Math.max(1.5, cam.scale * 0.03) / cam.scale;
    const ec = rgba('#ffe066', e);
    for (const en of world.enemies) {
      const x = lerp(en.prevX, en.x, alpha);
      const y = lerp(en.prevY, en.y, alpha);
      for (const side of [-1, 1]) this.batch.push(x, y, 0.34, side * eye * 1.8 - eye, -eye, eye * 2, 0, 0, eye * 2, dot, ec);
    }
    this.flush(this.atlas.tex);
  }

  private overlays(world: World, alpha: number, v: View): void {
    const cam = this.cam;
    const white = this.sp(ID.white);
    const shot = rgba(C.shot);
    for (const s of world.shots) {
      const [ax, ay] = cam.project(s.fromX, s.fromY, 0.6);
      const [bx, by] = cam.project(s.toX, s.toY, 0.32);
      this.line(ax, ay, bx, by, 2, shot);
    }
    const s = cam.scale;
    const w = 0.45;
    const bg = rgba(C.hpBg);
    // (x, y, z) world anchor; offsets in px converted to tiles.
    const bar = (x: number, y: number, z: number, offPx: number, hPx: number, f: number, col: string) => {
      const hh = hPx / s;
      const oy = offPx / s;
      const px = 1 / s;
      this.batch.push(x, y, z, -w / 2 - px, oy - px, w + 2 * px, 0, 0, hh + 2 * px, white, bg);
      this.batch.push(x, y, z, -w / 2, oy, Math.max(hh, w * Math.max(0, Math.min(1, f))), 0, 0, hh, white, rgba(col));
    };
    for (const [k, t] of world.grid.tiles) {
      if (!inView(k, v)) continue;
      const max = BUILDINGS[t.b].hp;
      const top = HEIGHT[t.b] ?? 0;
      if (t.hp < max) bar(kx(k) + 0.5, ky(k) + 0.5, top, -12, 4, t.hp / max, C.hpFg);
      if (t.b === Building.Turret && t.ammo > 0) bar(kx(k) + 0.5, ky(k) + 0.5, top, -7, 3, t.ammo / TURRET.maxAmmo, C.turret);
    }
    for (const e of world.enemies) {
      if (e.hp >= e.maxHp) continue;
      bar(lerp(e.prevX, e.x, alpha), lerp(e.prevY, e.y, alpha), 0.32, -s * 0.15 - 8, 3, e.hp / e.maxHp, C.hpFg);
    }
  }

  // ------------------------------------------------------------ plumbing

  /** Draw the batch. nmode: 0 = don't touch normals, 1 = lit sprite (normal atlas), 2 = flat on the ground. */
  private flush(tex: WebGLTexture | null, nmode = 0): void {
    const b = this.batch;
    if (b.n === 0) return;
    const gl = this.gl;
    const cam = this.cam;
    gl.useProgram(this.sprite);
    gl.uniform2f(this.u.su_res!, this.cssW, this.cssH);
    gl.uniform3f(this.u.su_cam!, cam.ox, cam.oy, cam.scale);
    gl.uniform1i(this.u.su_tex!, 0);
    gl.uniform1i(this.u.su_nmode!, nmode);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas.ntex);
    gl.uniform1i(this.u.su_ntex!, 4);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, b.data.subarray(0, b.n * FLOATS), gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.n);
    b.n = 0;
  }

  private ensureGBuffer(): NonNullable<GLRenderer['gb']> {
    const gl = this.gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    if (this.gb && this.gb.w === w && this.gb.h === h) return this.gb;
    if (this.gb) {
      gl.deleteFramebuffer(this.gb.fbo);
      gl.deleteTexture(this.gb.albedo);
      gl.deleteTexture(this.gb.normal);
      gl.deleteRenderbuffer(this.gb.ds);
    }
    const tex = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    };
    const albedo = tex();
    const normal = tex();
    const ds = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, ds);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, albedo, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, normal, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, ds);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.gb = { fbo, albedo, normal, ds, w, h };
    return this.gb;
  }

  private makeGlow(): WebGLTexture {
    const gl = this.gl;
    const n = 128;
    const { c, g } = cpuCanvas(n, n);
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
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  dispose(): void {
    this.statics.dispose();
    this.terrain.dispose();
    this.atlas.dispose();
    this.next?.dispose();
  }
}

/** Height and colour of a building's light. */
function lightLook(b: Building, on: boolean): [number, number[]] {
  switch (b) {
    case Building.Core:
      return [1.4, [0.75, 1.0, 0.9]];
    case Building.Turret:
      return [0.9, [1.0, 0.85, 0.62]];
    case Building.Furnace:
      return on ? [0.35, [1.0, 0.58, 0.26]] : [0.4, [0.5, 0.35, 0.22]];
    default:
      return [1.0, [0.9, 0.75, 0.5]];
  }
}

function inView(k: number, v: View): boolean {
  const x = kx(k);
  const y = ky(k);
  return x >= v.x0 && x <= v.x1 && y >= v.y0 && y <= v.y1;
}
