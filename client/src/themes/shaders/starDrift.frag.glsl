precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform vec3 uBgColor;

// Voyager — quiet parallax starfield. Near stars drift a little faster
// than far stars (horizontal drift, left→right); far stars are nearly
// still. A few stars twinkle. Nothing else moves. The background is
// meant to read as deep space looking out a porthole, not a radar or
// plotter display — the chrome/typography carries the mission-control
// identity; the shader just gives depth.

float hash(float n) { return fract(sin(n) * 43758.5453); }
vec2 hash2(float n) { return vec2(hash(n), hash(n + 91.7)); }

void main() {
  vec2 frag = vec2(vUv.x, 1.0 - vUv.y) * uResolution;
  vec3 color = vec3(0.0);
  float alpha = 0.0;

  // Parallax starfield: 110 points across two layers. Near layer drifts
  // slightly faster + slightly larger than far. Twinkle is per-star
  // (seeded on index) so a few feel alive without the field boiling.
  for (int i = 0; i < 110; i++) {
    float fi = float(i);
    vec2 seed = hash2(fi * 3.17);
    float nearFar = step(0.55, hash(fi + 7.7));
    float driftSpeed = mix(0.8, 2.5, nearFar);
    vec2 c;
    c.x = mod(seed.x * uResolution.x + uTime * driftSpeed, uResolution.x);
    c.y = seed.y * uResolution.y;
    float d = length(frag - c);
    float size = mix(0.7, 1.5, nearFar);
    float s = exp(-d * d / (size * size));
    // Only a small subset twinkle; rest are steady
    float twinkleOn = step(0.82, hash(fi + 21.1));
    float twinkle = 1.0 - twinkleOn * (0.35 + 0.35 * sin(uTime * 0.9 + fi * 1.7));
    vec3 starColor = mix(vec3(1.0), uSecondaryColor, 0.28);
    float b = (0.5 + 0.5 * nearFar) * twinkle;
    color += starColor * s * b;
    alpha += s * b;
  }

  // (Vignette removed — radial gradient banded against the dark base.)
  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
}
