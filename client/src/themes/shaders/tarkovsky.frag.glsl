precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;    // rust — accent
uniform vec3 uSecondaryColor;  // moss green — the Zone's cold palette
uniform vec3 uBgColor;
uniform float uTension;

// TARKOVSKY — Stalker / Mirror register. Stripped to grain-only: the
// noise-shaped scan bands and shadow sepia tint banded against
// near-black. What remains is the heaviest grain pass in the registry,
// luminance-aware, evoking 35mm projection texture without painting any
// soft gradient onto the canvas.

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 frag = vUv * uResolution;

  // Two grain octaves so the texture has both a fine and a coarse layer.
  float fine = hash(frag + vec2(mod(uTime * 41.0, 4096.0), mod(uTime * 31.0, 4096.0)));
  float coarse = hash(floor(frag / 2.0) + vec2(mod(uTime * 18.0, 4096.0), mod(uTime * 23.0, 4096.0)));
  float grain = mix(fine, coarse, 0.45);
  float g = (grain - 0.5);

  // Tint grain faintly toward primary/secondary so the rust/moss palette
  // reads in the texture itself.
  vec3 warm = uPrimaryColor;
  vec3 cool = uSecondaryColor;
  vec3 tint = mix(warm, cool, hash(floor(frag / 4.0)) * 0.6);
  vec3 col = g >= 0.0 ? mix(vec3(1.0), tint, 0.40) : vec3(0.0);

  float strength = 0.18 + uTension * 0.06;
  float alpha = clamp(abs(g) * strength, 0.0, 0.32);

  gl_FragColor = vec4(col, alpha);
}
