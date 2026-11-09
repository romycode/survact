// Shared material for everything in the world: terrain, vegetation, colonists, buildings.
// Flat-shaded low-poly look comes from the meshes (one normal per face).
//
// Vertex color ALPHA encodes the surface kind so one shader serves all geometry:
//   1.00  ground top     → per-tile snow coverage driven by survact_frost
//   0.66  foliage        → snow settles on upward-facing faces
//   0.33  water          → turns to ice when it gets cold enough
//   0.00  never snowed   → trunks, cliff sides, colonists, building walls
// survact_frost (0..1) is a project-wide global uniform set once per frame by LightingRig,
// so the whole world reacts to temperature without rebuilding a single mesh.
shader_type spatial;
render_mode cull_disabled, specular_disabled;

global uniform float survact_frost;

uniform vec3 base_color : source_color = vec3(1.0);
uniform vec3 snow_color : source_color = vec3(0.86, 0.89, 0.94);
uniform vec3 ice_color : source_color = vec3(0.58, 0.71, 0.82);
uniform vec3 emission_color : source_color = vec3(0.0);
uniform float emission_energy = 0.0;

// Holographic look: opaque geometry, no costly transparency or extra lights.
uniform bool holographic_enabled = true;
uniform vec3 hologram_cyan : source_color = vec3(0.02, 0.68, 0.95);
uniform vec3 hologram_amber : source_color = vec3(1.0, 0.35, 0.07);
uniform float hologram_grid_scale = 1.0;
uniform float hologram_grid_width = 0.025;
uniform float hologram_energy = 0.6;

varying vec3 world_pos;
varying vec3 world_normal;

float hash(vec2 p) {
	return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float value_noise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	f = f * f * (3.0 - 2.0 * f);
	float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
	return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Snow settles in drifts, not salt and pepper: low-frequency noise decides the patches,
// a little per-tile jitter keeps the edges ragged. 0 frost = none, 0.85 = everything.
bool tile_has_snow(vec2 tile, float frost) {
	float coverage = value_noise(tile * 0.17) * 0.72 + hash(tile) * 0.28;
	return frost > 0.0 && coverage < frost / 0.85 * 1.1 - 0.05;
}

void vertex() {
	world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
	world_normal = normalize((MODEL_MATRIX * vec4(NORMAL, 0.0)).xyz);
}

void fragment() {
	vec3 col = COLOR.rgb * base_color;
	float kind = COLOR.a;
	float frost = clamp(survact_frost, 0.0, 1.0);

	if (kind > 0.9) {
		// Ground: each tile is either covered or not; coverage spreads as it gets colder.
		vec2 tile = floor(world_pos.xz);
		if (world_normal.y > 0.5 && tile_has_snow(tile, frost)) {
			col = snow_color * (0.96 + 0.04 * hash(tile + 17.0));
		}
	} else if (kind > 0.5) {
		float up = smoothstep(0.25, 0.85, world_normal.y);
		col = mix(col, snow_color, up * frost);
	} else if (kind > 0.2) {
		if (frost > 0.5) col = ice_color;
	}

	// Hemispheric shading: faces lit by the open sky (up) are brighter than walls, walls brighter
	// than undersides. Makes form readable from any angle, independent of the sun.
	col *= mix(0.72, 1.0, clamp(world_normal.y * 0.5 + 0.5, 0.0, 1.0));

	if (holographic_enabled) {
		// Ground grid follows world coordinates; snow stays visible above it.
		vec2 grid_uv = world_pos.xz * hologram_grid_scale;
		vec2 cell = abs(fract(grid_uv) - 0.5);
		float line = 1.0 - smoothstep(hologram_grid_width, hologram_grid_width + max(fwidth(grid_uv.x), fwidth(grid_uv.y)), 0.5 - max(cell.x, cell.y));
		float ground = step(0.9, kind) * smoothstep(0.4, 0.8, world_normal.y);
		// Silhouette highlights on structures, without transparent overdraw.
		float rim = pow(1.0 - clamp(dot(normalize(NORMAL), normalize(VIEW)), 0.0, 1.0), 3.0);
		vec3 accent = mix(hologram_cyan, hologram_amber, step(0.75, emission_energy));
		float snow = ground * frost;
		col = mix(col, col * vec3(0.16, 0.29, 0.40), 0.48 * (1.0 - snow));
		EMISSION = emission_color * emission_energy + accent * hologram_energy * (ground * line * 0.6 + rim * (1.0 - ground) * 0.35);
	} else {
		EMISSION = emission_color * emission_energy;
	}

	ALBEDO = col;
	ROUGHNESS = 1.0;
}
