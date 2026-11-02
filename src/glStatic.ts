// Buildings, belts and shadows kept on the GPU.
//
// Instance buffers are rebuilt only when the grid changes (place, remove,
// rotate). Per frame the CPU writes one byte per building — which baked
// variant to show (turret aim, furnace lit, core gem phase…) — into a small
// R8UI texture; the vertex shader looks the sprite rect up in a table texture.
// Belts are drawn procedurally by a shader as continuous lines (see belts.ts),
// and sun shadows are built in the vertex shader from the same buffer.

import { DEPTH } from './camera';
import { beltLooks, BAND0, CAP_END, CAP_START, CAP_W, RAIL0 } from './belts';
import { AIM_STEPS, BELT_COLORS, HEIGHT, aimStep } from './render';
import { Building, isBelt } from './sim/defs';
import { kx, ky, type Tile } from './sim/grid';
import type { World } from './sim/world';

export interface Sprite {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Placement relative to the anchor, in tiles (× scale on screen). */
  dx: number;
  dy: number;
  w: number;
  h: number;
}

/** Atlas sprite ids. */
export const ID = {
  building: (b: number, dir: number, variant: number) => b * 1000 + dir * 100 + variant,
  mite: (hq: number, sq: number, lq: number) => 10000 + hq * 100 + sq * 10 + lq,
  item: (it: number) => 30000 + it,
  white: 40000,
  dot: 40001,
  edge: 40002,
  edgeSel: 40003,
  cross: 40004,
  arrow: (d: number) => 40010 + d,
};

export const CORE_PHASES = 8;

// Static sprite slots: base per building (+ variant from the state texture).
const SLOT_CORE = 0;
const SLOT_WALL = SLOT_CORE + CORE_PHASES;
const SLOT_MINER = SLOT_WALL + 1; // + dir*2 + on
const SLOT_FURNACE = SLOT_MINER + 8; // + dir*2 + on
const SLOT_TURRET = SLOT_FURNACE + 8; // + aim + empty*AIM_STEPS
const SLOTS = SLOT_TURRET + AIM_STEPS * 2;

function slotSprite(slot: number): number {
  if (slot < SLOT_WALL) return ID.building(Building.Core, 0, slot - SLOT_CORE);
  if (slot < SLOT_MINER) return ID.building(Building.Wall, 0, 0);
  if (slot < SLOT_FURNACE) {
    const i = slot - SLOT_MINER;
    return ID.building(Building.Miner, i >> 1, i & 1);
  }
  if (slot < SLOT_TURRET) {
    const i = slot - SLOT_FURNACE;
    return ID.building(Building.Furnace, i >> 1, i & 1);
  }
  return ID.building(Building.Turret, 0, slot - SLOT_TURRET);
}

function baseSlot(t: Tile): number {
  switch (t.b) {
    case Building.Core:
      return SLOT_CORE;
    case Building.Miner:
      return SLOT_MINER + t.dir * 2;
    case Building.Furnace:
      return SLOT_FURNACE + t.dir * 2;
    case Building.Turret:
      return SLOT_TURRET;
    default:
      return SLOT_WALL;
  }
}

const D = DEPTH.toFixed(4);
const POS = `
  float s = u_cam.z;
  gl_Position = vec4(p / u_res * 2.0 - 1.0, 0.0, 1.0) * vec4(1.0, -1.0, 1.0, 1.0);`;

const STATIC_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_inst; // x, y, base slot, height
uniform vec2 u_res;
uniform vec3 u_cam;
uniform highp sampler2D u_table;
uniform highp usampler2D u_state;
uniform int u_first;
out vec2 v_uv;
void main() {
  int id = u_first + gl_InstanceID;
  int slot = int(a_inst.z) + int(texelFetch(u_state, ivec2(id & 255, id >> 8), 0).r);
  vec4 uv = texelFetch(u_table, ivec2(0, slot), 0);
  vec4 g = texelFetch(u_table, ivec2(1, slot), 0);
  float sc = u_cam.z;
  vec2 p = vec2(u_cam.x + a_inst.x * sc, u_cam.y + a_inst.y * sc * ${D}) + (g.xy + a_corner * g.zw) * sc;
  ${POS}
  v_uv = mix(uv.xy, uv.zw, a_corner);
}`;

const STATIC_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 o;
void main() { o = texture(u_tex, v_uv); }`;

const SHADOW_VS = `#version 300 es
layout(location=1) in vec4 a_inst;
uniform vec2 u_res;
uniform vec3 u_cam;
uniform vec2 u_sun;
const int FAN[12] = int[12](0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5);
void main() {
  float a = a_inst.x + 0.08, b = a_inst.x + 0.92, c = a_inst.y + 0.08, d = a_inst.y + 0.92;
  float u = u_sun.x * a_inst.w, w = u_sun.y * a_inst.w;
  vec2 hex[6] = vec2[6](vec2(a, c), vec2(b, c), vec2(b + u, c + w), vec2(b + u, d + w), vec2(a + u, d + w), vec2(a, d));
  vec2 g = hex[FAN[gl_VertexID]];
  float sc = u_cam.z;
  vec2 p = vec2(u_cam.x + g.x * sc, u_cam.y + g.y * sc * ${D});
  ${POS}
}`;

const SOLID_FS = `#version 300 es
precision mediump float;
uniform vec4 u_col;
out vec4 o;
void main() { o = u_col; }`;

function vec(css: string): string {
  const h = css.replace('#', '');
  return `vec3(${[0, 2, 4].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(4)).join(',')})`;
}

const BELT_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_inst; // x, y, dir + 4*shape, caps + 4*fast
uniform vec2 u_res;
uniform vec3 u_cam;
out vec2 v_f;
flat out ivec3 v_k; // dir, shape, caps
flat out int v_fast;
void main() {
  float sc = u_cam.z;
  vec2 p = vec2(u_cam.x + (a_inst.x + a_corner.x) * sc, u_cam.y + (a_inst.y + a_corner.y) * sc * ${D});
  ${POS}
  v_f = a_corner;
  int k = int(a_inst.z);
  int c = int(a_inst.w);
  v_k = ivec3(k & 3, k >> 2, c & 3);
  v_fast = c >> 2;
}`;

const BELT_FS = `#version 300 es
precision highp float;
in vec2 v_f;
flat in ivec3 v_k;
flat in int v_fast;
uniform vec2 u_phase;  // slow, fast
uniform float u_px;    // ground units per device px (along the squashed axis)
out vec4 o;
const vec3 FRAME = ${vec(BELT_COLORS.frame)};
const vec3 BAND = ${vec(BELT_COLORS.band)};
const vec3 FAST_BAND = ${vec(BELT_COLORS.fastBand)};
const vec3 SLAT = ${vec(BELT_COLORS.slat)};
const vec3 FAST_SLAT = ${vec(BELT_COLORS.fastSlat)};
const vec3 RAIL = ${vec(BELT_COLORS.rail)};
const vec3 INK = ${vec(BELT_COLORS.ink)};
const vec3 BUMPER = ${vec(BELT_COLORS.bumper)};
const float R0 = ${RAIL0.toFixed(3)};
const float B0 = ${BAND0.toFixed(3)};
const float CW = ${CAP_W.toFixed(3)};

float cov(float d) { return clamp(0.5 - d / u_px, 0.0, 1.0); } // d: signed distance, <0 inside

void main() {
  vec2 f = v_f;
  int dir = v_k.x;
  // Tile-local -> canonical (belt runs along +x)
  vec2 q = dir == 0 ? f : dir == 1 ? vec2(f.y, 1.0 - f.x) : dir == 2 ? 1.0 - f : vec2(1.0 - f.y, f.x);
  float u, v;
  if (v_k.y == 0) {
    u = q.x; v = q.y;
  } else {
    vec2 qq = v_k.y == 1 ? q : vec2(q.x, 1.0 - q.y);
    vec2 p = qq - vec2(1.0, 0.0);
    float th = atan(p.y, p.x);
    u = (3.14159265 - th) / 1.5707963;
    v = length(p);
    if (v_k.y == 2) v = 1.0 - v;
  }
  bool fast = v_fast == 1;
  float u0 = (v_k.z & ${CAP_START}) != 0 ? CW : -1.0;
  float u1 = (v_k.z & ${CAP_END}) != 0 ? 1.0 - CW : 2.0;
  // Coverage of the whole belt (frame), anti-aliased on every edge.
  float across = abs(v - 0.5);
  float a = cov(across - (0.5 - R0)) * cov(u0 - u) * cov(u - u1);
  if (a <= 0.0) discard;
  vec3 col = fast ? RAIL : FRAME;
  float band = cov(across - (0.5 - B0));
  col = mix(col, fast ? FAST_BAND : BAND, band);
  // Moving chevrons, continuous across tiles (3 per tile)
  float cu = u + 0.46 * across;
  float ph = fast ? u_phase.y : u_phase.x;
  float k = fract((cu - ph) * 3.0);
  float dk = min(k, 1.0 - k) / 3.0;          // distance to the nearest chevron, along u
  float sl = cov(dk - 0.022) * band * step(across, 0.27);
  col = mix(col, fast ? FAST_SLAT : SLAT, sl);
  // Ink on the outer edges and the start plate
  float edge = cov(abs(across - (0.5 - R0)) - 0.6 * u_px * 1.6);
  col = mix(col, INK, edge);
  if ((v_k.z & ${CAP_START}) != 0) col = mix(col, INK, cov(abs(u - u0) - 0.6 * u_px * 1.6));
  // End bumper
  if ((v_k.z & ${CAP_END}) != 0) {
    float bm = cov(u - (u1 - 0.07)); // 1 before the bumper
    col = mix(col, BUMPER, 1.0 - bm);
    col = mix(col, INK, cov(abs(u - (u1 - 0.07)) - 0.6 * u_px * 1.6));
    col = mix(col, INK, cov(abs(u - u1) - 0.6 * u_px * 1.6));
  }
  o = vec4(col * a, a);
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

const STRIDE = 4; // floats per instance

export class GLStatic {
  private readonly gl: WebGL2RenderingContext;
  private readonly prog: WebGLProgram;
  private readonly shadowProg: WebGLProgram;
  private readonly beltProg: WebGLProgram;
  private readonly u: Record<string, WebGLUniformLocation | null> = {};
  private readonly vao: WebGLVertexArrayObject;
  private readonly shadowVao: WebGLVertexArrayObject;
  private readonly beltVao: WebGLVertexArrayObject;
  private readonly buf: WebGLBuffer;
  private readonly beltBuf: WebGLBuffer;
  private readonly table: WebGLTexture;
  private stateTex: WebGLTexture | null = null;
  private stateRows = 0;
  private world: World | null = null;
  private version = -1;

  /** Buildings (no belts), sorted north to south, then west to east. */
  tiles: Tile[] = [];
  xs = new Int32Array(0);
  ys = new Int32Array(0);
  private state = new Uint8Array(0);
  belts = 0;
  rebuilds = 0;

  constructor(gl: WebGL2RenderingContext, cornerBuf: WebGLBuffer) {
    this.gl = gl;
    this.prog = compile(gl, STATIC_VS, STATIC_FS);
    this.shadowProg = compile(gl, SHADOW_VS, SOLID_FS);
    this.beltProg = compile(gl, BELT_VS, BELT_FS);
    for (const [p, names] of [
      [this.prog, ['u_res', 'u_cam', 'u_table', 'u_state', 'u_first', 'u_tex']],
      [this.shadowProg, ['u_res', 'u_cam', 'u_sun', 'u_col']],
      [this.beltProg, ['u_res', 'u_cam', 'u_phase', 'u_px']],
    ] as const) {
      const tag = p === this.prog ? 's' : p === this.shadowProg ? 'h' : 'b';
      for (const n of names) this.u[tag + n] = gl.getUniformLocation(p, n);
    }

    this.buf = gl.createBuffer()!;
    this.beltBuf = gl.createBuffer()!;
    const mk = (buf: WebGLBuffer, corners: boolean) => {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      if (corners) {
        gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE * 4, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.bindVertexArray(null);
      return vao;
    };
    this.vao = mk(this.buf, true);
    this.shadowVao = mk(this.buf, false);
    this.beltVao = mk(this.beltBuf, true);

    this.table = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.table);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 2, SLOTS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  /** Point the sprite table at a (new) atlas. */
  setAtlas(map: Map<number, Sprite>): void {
    const gl = this.gl;
    const d = new Float32Array(SLOTS * 8);
    for (let i = 0; i < SLOTS; i++) {
      const sp = map.get(slotSprite(i));
      if (!sp) continue;
      d.set([sp.u0, sp.v0, sp.u1, sp.v1, sp.dx, sp.dy, sp.w, sp.h], i * 8);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.table);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 2, SLOTS, gl.RGBA, gl.FLOAT, d);
  }

  /** Rebuild instance buffers if the grid changed since last frame. */
  sync(world: World): void {
    if (world === this.world && world.grid.version === this.version) return;
    this.world = world;
    this.version = world.grid.version;
    this.rebuilds++;
    const gl = this.gl;
    const list: [number, number, Tile][] = [];
    const belts: number[] = [];
    const looks = beltLooks(world);
    for (const [k, t] of world.grid.tiles) {
      const x = kx(k);
      const y = ky(k);
      if (isBelt(t.b)) {
        const l = looks.get(k)!;
        belts.push(x, y, t.dir + 4 * l.shape, l.caps + (t.b === Building.FastBelt ? 4 : 0));
      } else list.push([x, y, t]);
    }
    list.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const n = list.length;
    const data = new Float32Array(n * STRIDE);
    this.tiles = new Array(n);
    this.xs = new Int32Array(n);
    this.ys = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const [x, y, t] = list[i];
      this.tiles[i] = t;
      this.xs[i] = x;
      this.ys[i] = y;
      data.set([x, y, baseSlot(t), HEIGHT[t.b] ?? 0.5], i * STRIDE);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.beltBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(belts), gl.STATIC_DRAW);
    this.belts = belts.length / 4;

    const rows = Math.max(1, Math.ceil(n / 256));
    if (rows > this.stateRows) {
      if (this.stateTex) gl.deleteTexture(this.stateTex);
      this.stateRows = Math.max(rows, this.stateRows * 2);
      this.stateTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.stateTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, 256, this.stateRows);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.state = new Uint8Array(this.stateRows * 256);
    }
  }

  /** Per frame: one byte per building selecting its baked variant. */
  updateState(time: number): void {
    const n = this.tiles.length;
    if (n === 0) return;
    const st = this.state;
    const core = Math.floor(((time / 28 / (Math.PI * 2)) % 1) * CORE_PHASES);
    for (let i = 0; i < n; i++) {
      const t = this.tiles[i];
      switch (t.b) {
        case Building.Core:
          st[i] = core;
          break;
        case Building.Turret:
          st[i] = aimStep(this.xs[i], this.ys[i]) + (t.ammo === 0 ? AIM_STEPS : 0);
          break;
        case Building.Miner:
        case Building.Furnace:
          st[i] = t.cd > 0 ? 1 : 0;
          break;
        default:
          st[i] = 0;
      }
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const rows = Math.ceil(n / 256);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, rows, gl.RED_INTEGER, gl.UNSIGNED_BYTE, st, 0);
  }

  /** Index range of buildings in rows [y0, y1]. */
  range(y0: number, y1: number): [number, number] {
    const lb = (y: number) => {
      let lo = 0;
      let hi = this.ys.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (this.ys[m] < y) lo = m + 1;
        else hi = m;
      }
      return lo;
    };
    return [lb(y0), lb(y1 + 1)];
  }

  /** Painter's depth of building i (same key as the dynamic items). */
  depth(i: number): number {
    return this.ys[i] + 1 + this.xs[i] * 1e-4;
  }

  drawBuildings(i0: number, i1: number, cam: { ox: number; oy: number; scale: number }, cssW: number, cssH: number, atlas: WebGLTexture): void {
    if (i1 <= i0) return;
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniform2f(this.u.su_res!, cssW, cssH);
    gl.uniform3f(this.u.su_cam!, cam.ox, cam.oy, cam.scale);
    gl.uniform1i(this.u.su_first!, i0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.uniform1i(this.u.su_tex!, 0);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.table);
    gl.uniform1i(this.u.su_table!, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex);
    gl.uniform1i(this.u.su_state!, 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.vao);
    // No base-instance in WebGL2: start the instance attribute at i0 instead.
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE * 4, i0 * STRIDE * 4);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, i1 - i0);
  }

  drawShadows(cam: { ox: number; oy: number; scale: number }, cssW: number, cssH: number, sun: [number, number], color: [number, number, number, number]): void {
    const n = this.tiles.length;
    if (n === 0) return;
    const gl = this.gl;
    gl.useProgram(this.shadowProg);
    gl.uniform2f(this.u.hu_res!, cssW, cssH);
    gl.uniform3f(this.u.hu_cam!, cam.ox, cam.oy, cam.scale);
    gl.uniform2f(this.u.hu_sun!, sun[0], sun[1]);
    gl.uniform4fv(this.u.hu_col!, color);
    gl.bindVertexArray(this.shadowVao);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilFunc(gl.EQUAL, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 12, n);
    gl.disable(gl.STENCIL_TEST);
  }

  drawBelts(cam: { ox: number; oy: number; scale: number }, cssW: number, cssH: number, dpr: number, phase: [number, number]): void {
    if (this.belts === 0) return;
    const gl = this.gl;
    gl.useProgram(this.beltProg);
    gl.uniform2f(this.u.bu_res!, cssW, cssH);
    gl.uniform3f(this.u.bu_cam!, cam.ox, cam.oy, cam.scale);
    gl.uniform2f(this.u.bu_phase!, phase[0], phase[1]);
    gl.uniform1f(this.u.bu_px!, 1 / (cam.scale * DEPTH * dpr));
    gl.bindVertexArray(this.beltVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.belts);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.buf);
    gl.deleteBuffer(this.beltBuf);
    gl.deleteTexture(this.table);
    if (this.stateTex) gl.deleteTexture(this.stateTex);
  }
}
