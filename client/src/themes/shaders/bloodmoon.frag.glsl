precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform vec3 uBgColor;
uniform float uTension;

// Bloodmoon — atmospheric red, structural-only. The corner-haze blob and
// vignette darken were removed (they banded as concentric rings against
// near-black at low alpha). What remains is the structural film-leader
// burst: a vertical reddish band that flashes once per ~30s and fades.
// The crimson token palette and CSS glow on UI text carry the rest of
// the theme identity.

float hash(float n) { return fract(sin(n) * 43758.5453); }

void main() {
  // Film-leader wash — vertical band that fires on a slow window.
  float window = floor(uTime / 30.0);
  float bandSeed = hash(window + 11.1);
  float bandX = bandSeed * uResolution.x;
  float bandPhase = fract(uTime / 30.0);
  float bandActive = smoothstep(0.06, 0.0, bandPhase) * smoothstep(0.0, 0.01, bandPhase);
  float bandD = abs(vUv.x * uResolution.x - bandX) / 60.0;
  float band = exp(-bandD * bandD) * bandActive * 0.35;

  vec3 color = uPrimaryColor * band;
  float alpha = clamp(band, 0.0, 0.55);

  gl_FragColor = vec4(color, alpha);
}
