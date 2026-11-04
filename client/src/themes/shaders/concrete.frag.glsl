precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform vec3 uBgColor;

// Concrete — brutalist material. Two very quiet effects:
//  1. Aggregate speckle: high-frequency static hash evoking the grit in
//     raw poured concrete. Low alpha so it reads as texture, not noise.
//  2. Slow diagonal shadow: a soft dark band crosses the screen once
//     every ~90s, like afternoon light moving across an exposed wall.
// No pulsing, no flicker — the theme is about weight and stillness.

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 frag = vec2(vUv.x, 1.0 - vUv.y) * uResolution;

  // Aggregate: fine static speckle. No time animation — concrete doesn't
  // boil. Centered around 0 so it both lights and darkens.
  float s1 = hash(floor(frag / 2.0));
  float s2 = hash(floor(frag / 5.0) + 7.7);
  float speckle = (mix(s1, s2, 0.4) - 0.5) * 0.08;

  // Diagonal shadow pass. Parametrise along a normalised diagonal axis;
  // the band is a narrow soft falloff that sweeps once per 90s.
  vec2 dir = normalize(vec2(1.0, 0.6));
  float proj = dot(frag, dir) / (uResolution.x + uResolution.y);
  float sweep = mod(uTime / 90.0, 1.0);
  float d = proj - sweep;
  // Band width ~0.18 of diagonal range, soft edges
  float shadow = exp(-d * d / 0.012) * 0.14;

  // (Corner vignette removed — radial gradient banded on dark base.)

  // Speckle emits in both directions; shadow only darkens. Output as
  // luminance-only (no hue) so the palette stays neutral-industrial.
  vec3 col = speckle >= 0.0 ? vec3(1.0) : vec3(0.0);
  float speckleA = abs(speckle) * 0.5;
  float shadowA = shadow * 0.65;

  // Composite: pick whichever contribution is larger this pixel; they
  // rarely overlap meaningfully.
  if (speckleA > shadowA) {
    gl_FragColor = vec4(col, speckleA);
  } else {
    gl_FragColor = vec4(0.0, 0.0, 0.0, shadowA);
  }
}
