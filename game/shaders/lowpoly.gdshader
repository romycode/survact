// Shared material for everything in the world: terrain, vegetation, colonists, buildings.
// Flat-shaded low-poly look comes from the meshes (one normal per face).
//
// Vertex color ALPHA encodes the surface kind so one shader serves all geometry:
//   1.00  ground top     → per-tile snow coverage driven by survact_frost
//   0.66  foliage        → snow settles on upward-facing faces
//   0.33  water          → turns to ice when it gets cold enough
//   0.12  rock faces     → exposed strata on cliffs and banks
//   0.00  never snowed   → trunks, colonists, building walls
// survact_frost (0..1) is a project-wide global uniform set once per frame by LightingRig,
// so the whole world reacts to temperature without rebuilding a single mesh.
shader_type spatial;
render_mode cull_disabled;

global uniform float survact_frost;

uniform vec3 base_color : source_color = vec3(1.0);
uniform vec3 snow_color : source_color = vec3(0.86, 0.89, 0.94);
uniform vec3 ice_color : source_color = vec3(0.58, 0.71, 0.82);
uniform vec3 emission_color : source_color = vec3(0.0);
uniform float emission_energy = 0.0;

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

// Layers sample world coordinates so their edges never repeat the tile grid.
float snow_coverage(vec2 p, float up, float frost) {
	float drift = value_noise(p * 0.21) * 0.72 + value_noise(p * 0.85) * 0.28;
	float threshold = frost * 1.32 - 0.07;
	return (1.0 - smoothstep(threshold - 0.09, threshold + 0.07, drift))
		* smoothstep(0.42, 0.80, up) * smoothstep(0.0, 0.09, frost);
}

void vertex() {
	world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
	world_normal = normalize((MODEL_MATRIX * vec4(NORMAL, 0.0)).xyz);
}

void fragment() {
	vec3 col = COLOR.rgb * base_color;
	float kind = COLOR.a;
	float frost = clamp(survact_frost, 0.0, 1.0);

	float gloss = 0.0;
	float roughness = 1.0;
	if (kind > 0.9) {
		vec2 p = world_pos.xz;
		float grain = value_noise(p * 3.3);
		float exposed = value_noise(p * 0.38);
		float up = world_normal.y;
		col *= mix(0.74, 1.16, exposed) * mix(0.92, 1.05, grain);
		float snow = snow_coverage(p, up, frost);
		col = mix(col, snow_color * mix(0.81, 1.03, grain), snow);
	} else if (kind > 0.5) {
		float up = smoothstep(0.25, 0.85, world_normal.y);
		col = mix(col, snow_color, up * frost);
	} else if (kind > 0.2) {
		vec2 p = world_pos.xz;
		float ice = smoothstep(0.53, 0.69, frost + 0.13 * (value_noise(p * 0.8) - 0.5));
		float wave = sin(dot(p, vec2(2.8, 4.2)) + TIME * 1.5 + value_noise(p * 0.5) * 6.0);
		col *= 0.96 + 0.045 * wave * (1.0 - ice);
		col = mix(col, ice_color * mix(0.72, 0.95, value_noise(p * 0.9)), ice);
		roughness = mix(0.27, 0.54, ice);
		gloss = mix(0.46, 0.22, ice);
	} else if (kind > 0.06) {
		vec2 p = vec2(world_pos.x + world_pos.z * 0.82, world_pos.y);
		float joint = value_noise(p * vec2(1.9, 4.2));
		float strata = fract(p.y * 2.60 + p.x * 0.18 + joint * 0.40);
		float seam = smoothstep(0.04, 0.25, strata) * (1.0 - smoothstep(0.84, 1.0, strata));
		col *= mix(0.67, 1.20, seam) * mix(0.77, 1.16, joint);
	}

	// Hemispheric shading: faces lit by the open sky (up) are brighter than walls, walls brighter
	// than undersides. Makes form readable from any angle, independent of the sun.
	col *= mix(0.72, 1.0, clamp(world_normal.y * 0.5 + 0.5, 0.0, 1.0));

	ALBEDO = col;
	ROUGHNESS = roughness;
	SPECULAR = gloss;
	EMISSION = emission_color * emission_energy;
}
