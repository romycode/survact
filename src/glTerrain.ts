// Terrain drawn entirely on the GPU.
//
// The CPU keeps a toroidal window of tile bytes around the camera
// (ground type + ore nugget count) in an R8UI texture; a full-screen fragment
// shader turns each pixel back into world coordinates and draws the grass
// checker, tufts/pebbles/cogs, water with crests, banks, foam, ore nuggets and
// the grid procedurally — the same look as paintTerrain() in terrainLayer.ts,
// crisp at any zoom, with nothing to rasterise or upload when you pan or zoom.
//
// Per frame the CPU only refills the strip of tiles that scrolled into the
// window (when the camera crosses a margin) and patches single texels when
// an ore tile's nugget count changes.

import { DEPTH, RISE, type Camera } from './camera';
import { key } from './sim/grid';
import { Ground } from './sim/terrain';
import type { World } from './sim/world';
import { BANK, T, oreNuggets } from './terrainLayer';

const N = 512; // window size in tiles (power of two)
const MARGIN = 12;

function vec(css: string): string {
  const h = css.replace('#', '');
  const c = [0, 2, 4].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(4));
  return `vec3(${c.join(',')})`;
}

const VS = `#version 300 es
layout(location=0) in vec2 a_corner;
void main() { gl_Position = vec4(a_corner * 2.0 - 1.0, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp usampler2D u_tiles;
uniform vec3 u_cam;   // ox, oy, scale (CSS px)
uniform vec2 u_res;   // CSS px
uniform float u_dpr;
out vec4 o;

const float DEPTH = ${DEPTH.toFixed(4)};
const float BANKH = ${((BANK * RISE) / DEPTH).toFixed(4)};
const int MASK = ${N - 1};
const vec3 LAND = ${vec(T.land)};
const vec3 LAND_ALT = ${vec(T.landAlt)};
const vec3 TUFT = ${vec(T.tuft)};
const vec3 PEBBLE = ${vec(T.pebble)};
const vec3 PEBBLE_HI = ${vec(T.pebbleHi)};
const vec3 COG = ${vec(T.cog)};
const vec3 INK = ${vec(T.ink)};
const vec3 BANK_C = ${vec(T.bank)};
const vec3 BANK_DARK = ${vec(T.bankDark)};
const vec3 WATER = ${vec(T.water)};
const vec3 WATER_LIGHT = ${vec(T.waterLight)};
const vec3 FOAM = ${vec(T.foam)};
const vec3 ORE = ${vec(T.ore)};
const vec3 ORE_HI = ${vec(T.oreHi)};
const vec3 ORE_GROUND = ${vec(T.oreGround)};

uint tileAt(ivec2 t) { return texelFetch(u_tiles, t & MASK, 0).r; }
uint groundOf(uint b) { return b & 3u; }

// Same hash as terrainLayer.ts (Math.imul chain, >>> 0, / 2^32).
float hash2(ivec2 t, int s) {
  uint h = (uint(t.x) * 374761393u) ^ (uint(t.y) * 668265263u) ^ (uint(s) * 83492791u);
  return float(h) / 4294967296.0;
}

vec3 col;
float AA;      // ground units per device pixel (along the squashed axis, worst case)

// Coverage of a signed distance (ground units, negative inside).
float fill(float d) { return clamp(0.5 - d / AA, 0.0, 1.0); }
// Coverage of a stroke of width wCss CSS px around distance 0.
float stroke(float d, float wCss) { return clamp(0.5 - (abs(d) - 0.5 * wCss * u_dpr * AA) / AA, 0.0, 1.0); }
void over(vec3 c, float a) { col = mix(col, c, a); }

float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
// Ellipse SDF approximation (radii r).
float ellipse(vec2 p, vec2 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-5);
}
// Axis-aligned rect coverage in tile-local coords, anti-aliased in device px.
float rect(vec2 f, vec2 a, vec2 b) {
  vec2 px = vec2(1.0 / (u_cam.z * u_dpr), 1.0 / (u_cam.z * DEPTH * u_dpr));
  vec2 c = clamp(min(f - a, b - f) / px + 0.5, 0.0, 1.0);
  return c.x * c.y;
}

void main() {
  vec2 css = vec2(gl_FragCoord.x / u_dpr, u_res.y - gl_FragCoord.y / u_dpr);
  float s = u_cam.z;
  vec2 w = vec2((css.x - u_cam.x) / s, (css.y - u_cam.y) / (s * DEPTH));
  ivec2 t = ivec2(floor(w));
  vec2 f = w - vec2(t);
  AA = 1.0 / (s * DEPTH * u_dpr);

  uint b = tileAt(t);
  uint g = groundOf(b);
  bool water = g == 2u;

  col = ((t.x + t.y) & 1) == 1 ? LAND : LAND_ALT;
  float deco = smoothstep(18.0, 22.0, s);

  if (g == 0u && deco > 0.0) {
    float r = hash2(t, 1);
    if (r <= 0.3) {
      vec2 c = vec2(0.2 + hash2(t, 2) * 0.6, 0.2 + hash2(t, 3) * 0.6);
      if (r < 0.012) {
        // A lost brass cog
        vec2 p = f - c;
        float a = atan(p.y, p.x);
        float seg = 6.2831853 / 16.0;
        float k = floor(a / seg);
        float fr = a / seg - k;
        float r0 = mod(k, 2.0) < 0.5 ? 0.065 : 0.09;   // vertex i: i%2 ? 0.09 : 0.065
        float r1 = mod(k, 2.0) < 0.5 ? 0.09 : 0.065;
        float d = length(p) - mix(r0, r1, fr);
        over(COG, fill(d) * deco);
        over(INK, stroke(d, 1.2) * deco);
        over(INK, fill(length(p) - 0.025) * deco);
      } else if (r < 0.06) {
        vec2 p = f - c;
        float cr = cos(-0.6), sr = sin(-0.6);
        vec2 q = vec2(cr * p.x - sr * p.y, sr * p.x + cr * p.y);
        over(PEBBLE, fill(ellipse(q, vec2(0.07, 0.05))) * deco);
        over(PEBBLE_HI, fill(length(p + vec2(0.02)) - 0.025) * deco);
      } else {
        float d = 1e9;
        d = min(d, segment(f, c + vec2(-0.07, 0.0), c + vec2(-0.11, -0.16)));
        d = min(d, segment(f, c, c + vec2(0.0, -0.16)));
        d = min(d, segment(f, c + vec2(0.07, 0.0), c + vec2(0.11, -0.16)));
        over(TUFT, stroke(d, 2.2) * deco);
      }
    }
  }

  if (water) {
    col = WATER;
    if (hash2(t, 7) <= 0.3) {
      // Crest: quadratic (0.25,0.55) -(0.4,0.4)- (0.55,0.55) as 4 segments
      float d = 1e9;
      vec2 prev = vec2(0.25, 0.55);
      for (int i = 1; i <= 4; i++) {
        float u = float(i) / 4.0;
        vec2 p = vec2(0.25 + 0.3 * u, 0.55 - 0.3 * u + 0.3 * u * u);
        d = min(d, segment(f, prev, p));
        prev = p;
      }
      over(WATER_LIGHT, stroke(d, 2.5));
    }
    bool n = groundOf(tileAt(t + ivec2(0, -1))) != 2u;
    bool wl = groundOf(tileAt(t + ivec2(-1, 0))) != 2u;
    bool e = groundOf(tileAt(t + ivec2(1, 0))) != 2u;
    if (n) over(BANK_DARK, rect(f, vec2(-1.0, -1.0), vec2(2.0, BANKH)));
    if (wl) over(BANK_C, rect(f, vec2(-1.0, -1.0), vec2(0.06, 2.0)));
    if (e) over(BANK_C, rect(f, vec2(0.94, -1.0), vec2(2.0, 2.0)));
    if (n) over(FOAM, rect(f, vec2(-1.0, BANKH), vec2(2.0, BANKH + 0.07)));
    if (wl) over(FOAM, rect(f, vec2(0.06, -1.0), vec2(0.11, 2.0)));
    if (e) over(FOAM, rect(f, vec2(0.89, -1.0), vec2(0.94, 2.0)));
  }

  if (g == 1u) {
    int nug = int(b >> 2u);
    if (nug > 0) {
      col = ORE_GROUND;
      for (int k = 0; k < 5; k++) {
        if (k >= nug) break;
        vec2 c = vec2(0.22 + hash2(t, 10 + k) * 0.56, 0.22 + hash2(t, 20 + k) * 0.56);
        float r = 0.09 + floor(hash2(t, 30 + k) * 4.0) * 0.025;
        float d = length(f - c) - r;
        over(ORE, fill(d));
        over(INK, stroke(d, 1.6));
        over(ORE_HI, fill(length(f - c + vec2(r * 0.3)) - r * 0.38));
      }
    }
  }

  // Grid
  float gridA = smoothstep(26.0, 30.0, s) * 0.08;
  if (gridA > 0.0) {
    float dx = min(f.x, 1.0 - f.x) * s * u_dpr;
    float dy = min(f.y, 1.0 - f.y) * s * DEPTH * u_dpr;
    float c = max(clamp(0.5 * u_dpr + 0.5 - dx, 0.0, 1.0), clamp(0.5 * u_dpr + 0.5 - dy, 0.0, 1.0));
    over(INK, c * gridA);
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

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class GLTerrain {
  private readonly gl: WebGL2RenderingContext;
  private readonly prog: WebGLProgram;
  private readonly u: Record<'tiles' | 'cam' | 'res' | 'dpr', WebGLUniformLocation>;
  private readonly tex: WebGLTexture;
  private readonly data = new Uint8Array(N * N);
  private rect: Rect | null = null;
  private world: World | null = null;
  /** Ore tiles inside the window, by key: [x, y]. */
  private ore = new Map<number, [number, number]>();
  private frame = 0;
  stats = { filled: 0, orePatched: 0 };

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.prog = compile(gl, VS, FS);
    this.u = {
      tiles: gl.getUniformLocation(this.prog, 'u_tiles')!,
      cam: gl.getUniformLocation(this.prog, 'u_cam')!,
      res: gl.getUniformLocation(this.prog, 'u_res')!,
      dpr: gl.getUniformLocation(this.prog, 'u_dpr')!,
    };
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, N, N);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  private byte(world: World, x: number, y: number): number {
    const g = world.terrain.at(x, y);
    if (g === Ground.Ore) {
      this.ore.set(key(x, y), [x, y]);
      return g | (oreNuggets(world.oreLeft(x, y)) << 2);
    }
    return g;
  }

  /** Make sure the window covers the view (plus margin) and ore counts are current. */
  private sync(world: World, cam: Camera): void {
    const gl = this.gl;
    if (world !== this.world) {
      this.world = world;
      this.rect = null;
      this.ore.clear();
    }
    this.frame++;
    const v = cam.visible();
    const need: Rect = { x0: v.x0 - 2, y0: v.y0 - 2, x1: v.x1 + 2, y1: v.y1 + 2 };
    const r = this.rect;
    if (!r || need.x0 < r.x0 || need.y0 < r.y0 || need.x1 > r.x1 || need.y1 > r.y1) {
      // New window: the view plus a margin, capped to the texture size.
      const cx = (need.x0 + need.x1) / 2;
      const cy = (need.y0 + need.y1) / 2;
      const hw = Math.min(N / 2 - 1, (need.x1 - need.x0) / 2 + MARGIN);
      const hh = Math.min(N / 2 - 1, (need.y1 - need.y0) / 2 + MARGIN);
      const nr: Rect = { x0: Math.floor(cx - hw), y0: Math.floor(cy - hh), x1: Math.ceil(cx + hw), y1: Math.ceil(cy + hh) };
      let filled = 0;
      for (let y = nr.y0; y <= nr.y1; y++) {
        const row = (y & (N - 1)) * N;
        for (let x = nr.x0; x <= nr.x1; x++) {
          if (r && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) continue; // already there
          this.data[row + (x & (N - 1))] = this.byte(world, x, y);
          filled++;
        }
      }
      for (const [k, [x, y]] of this.ore) if (x < nr.x0 || x > nr.x1 || y < nr.y0 || y > nr.y1) this.ore.delete(k);
      this.rect = nr;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RED_INTEGER, gl.UNSIGNED_BYTE, this.data);
      this.stats.filled = filled;
    }
    // Ore running out: patch single texels (checked a few times per second).
    if (this.frame % 15 === 0) {
      let patched = 0;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      for (const [x, y] of this.ore.values()) {
        const i = (y & (N - 1)) * N + (x & (N - 1));
        const nb = Ground.Ore | (oreNuggets(world.oreLeft(x, y)) << 2);
        if (this.data[i] !== nb) {
          this.data[i] = nb;
          gl.texSubImage2D(gl.TEXTURE_2D, 0, x & (N - 1), y & (N - 1), 1, 1, gl.RED_INTEGER, gl.UNSIGNED_BYTE, this.data, i);
          patched++;
        }
      }
      this.stats.orePatched += patched;
    }
  }

  draw(world: World, cam: Camera, quadVao: WebGLVertexArrayObject, dpr: number, cssW: number, cssH: number): void {
    const gl = this.gl;
    this.sync(world, cam);
    gl.disable(gl.BLEND);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u.tiles, 1);
    gl.uniform3f(this.u.cam, cam.ox, cam.oy, cam.scale);
    gl.uniform2f(this.u.res, cssW, cssH);
    gl.uniform1f(this.u.dpr, dpr);
    gl.bindVertexArray(quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.BLEND);
  }

  dispose(): void {
    this.gl.deleteTexture(this.tex);
  }
}
