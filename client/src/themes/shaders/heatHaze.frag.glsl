precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform vec3 uBgColor;

// Arrakis — slow heat shimmer + drifting sand. A warm horizontal gradient
// wash sits under fine ochre grain. Two slow horizontal "dust lines" drift
// across at different altitudes, like wind-driven sand.

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float hash1(float n) { return fract(sin(n) * 43758.5453); }

// Cheap 2d value noise for the shimmer field
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec2 frag = vec2(vUv.x, 1.0 - vUv.y) * uResolution;

  // Base warm wash — horizon-like gradient. Warmer at the bottom (hot sand)
  // fading to almost black near the top (night sky).
  float horizon = smoothstep(0.0, 0.55, vUv.y);
  vec3 wash = mix(uPrimaryColor * 0.18, vec3(0.0), horizon);

  // Heat shimmer — a low-frequency noise field scrolls upward slowly,
  // modulating luminance in a way that reads as hot air.
  float shimmer = noise(vec2(frag.x * 0.012, frag.y * 0.008 - uTime * 0.12));
  shimmer = (shimmer - 0.5) * 0.5;

  // Sand grain — high-frequency hash, time-animated. Wrap uTime*K into
  // hash with mod so the argument stays bounded; without this the grain
  // eventually freezes once fract(sin(...)) loses fractional resolution.
  float grain = hash(frag + vec2(mod(uTime * 30.0, 4096.0), mod(uTime * 19.0, 4096.0)));
  float g = (grain - 0.5) * 0.08;

  // Dust lines — two soft horizontal bands drifting slowly. Each seeded from
  // a different phase, so they rarely overlap.
  float dust1Y = mod(uTime * 7.0, uResolution.y + 120.0) - 60.0;
  float dust2Y = mod(uTime * 4.0 + uResolution.y * 0.4, uResolution.y + 120.0) - 60.0;
  float band1 = exp(-pow((frag.y - dust1Y) / 36.0, 2.0));
  float band2 = exp(-pow((frag.y - dust2Y) / 28.0, 2.0));
  // Modulate bands along x so they feel like wind, not a solid stripe
  float windMod1 = 0.5 + 0.5 * noise(vec2(frag.x * 0.015, uTime * 0.4));
  float windMod2 = 0.5 + 0.5 * noise(vec2(frag.x * 0.02, uTime * 0.3 + 17.0));
  float dust = band1 * windMod1 * 0.18 + band2 * windMod2 * 0.12;

  vec3 color = wash + uPrimaryColor * (shimmer + dust) + vec3(g);
  float alpha = clamp(horizon * 0.35 + shimmer + dust + abs(g) * 0.5, 0.0, 0.85);

  // (Vignette removed — radial gradient banded against the dark base.)
  gl_FragColor = vec4(color, alpha);
}
