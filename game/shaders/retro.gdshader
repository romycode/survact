// Post filter for the low-resolution 3D view (applied on the SubViewportContainer).
// The viewport already renders at 1/N resolution and is upscaled with nearest filtering;
// this adds colour posterization with 4x4 ordered (Bayer) dithering in low-res pixel space,
// which gives the "retro with style" look without real pixel art.
shader_type canvas_item;

uniform bool enabled = true;
uniform float levels : hint_range(2.0, 64.0) = 14.0;
uniform float dither_strength : hint_range(0.0, 1.0) = 0.55;

const float BAYER[16] = float[16](
	0.0, 8.0, 2.0, 10.0,
	12.0, 4.0, 14.0, 6.0,
	3.0, 11.0, 1.0, 9.0,
	15.0, 7.0, 13.0, 5.0
);

void fragment() {
	vec4 c = texture(TEXTURE, UV);
	if (enabled) {
		ivec2 p = ivec2(UV * vec2(textureSize(TEXTURE, 0)));
		float threshold = BAYER[(p.x & 3) + (p.y & 3) * 4] / 16.0 - 0.5;
		c.rgb = floor(c.rgb * levels + threshold * dither_strength + 0.5) / levels;
	}
	COLOR = c;
}
