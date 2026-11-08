shader_type spatial;

uniform vec4 metal_color : source_color;
uniform float metalness;
uniform float base_roughness;
uniform bool copper;

varying vec3 metal_position;

float hash(vec3 p) {
	p = fract(p * 0.3183099 + vec3(0.15, 0.32, 0.74));
	p *= 19.0;
	return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float value_noise(vec3 p) {
	vec3 i = floor(p);
	vec3 f = smoothstep(vec3(0.0), vec3(1.0), fract(p));
	vec2 z0 = mix(vec2(hash(i), hash(i + vec3(0, 1, 0))),
		vec2(hash(i + vec3(1, 0, 0)), hash(i + vec3(1, 1, 0))), f.x);
	vec2 z1 = mix(vec2(hash(i + vec3(0, 0, 1)), hash(i + vec3(0, 1, 1))),
		vec2(hash(i + vec3(1, 0, 1)), hash(i + vec3(1, 1, 1))), f.x);
	return mix(mix(z0.x, z0.y, f.y), mix(z1.x, z1.y, f.y), f.z);
}

void vertex() {
	metal_position = VERTEX;
}

void fragment() {
	float weathering = value_noise(metal_position * vec3(3.3, 1.9, 3.3));
	float grain = value_noise(metal_position * 15.0);
	float patina = copper ? smoothstep(0.64, 0.92, weathering) * 0.24 : 0.0;
	vec3 metal = metal_color.rgb * mix(0.69, 1.17, weathering) * mix(0.92, 1.06, grain);
	ALBEDO = mix(metal, vec3(0.08, 0.19, 0.13), patina);
	METALLIC = metalness * (1.0 - patina);
	ROUGHNESS = clamp(base_roughness + (weathering - 0.5) * 0.22 + patina * 0.25, 0.0, 1.0);
}
