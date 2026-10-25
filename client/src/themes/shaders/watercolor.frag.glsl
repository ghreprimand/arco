precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;    // sage
uniform vec3 uSecondaryColor;  // terracotta
uniform vec3 uBgColor;         // parchment

// Solar Paper — parchment with slow-drifting sage + terracotta watercolor
// blooms. Two coarse value-noise fields at different scales mix toward the
// theme primaries; the finite-difference gradient of the combined field (a
// Sobel-style edge detector) is added back as a wet-edge darkening so each
// bloom has a pooled rim. Output alpha stays high — the canvas sits at
// opacity 0.32 which already dims the wash to a subtle tint over the
// parchment CSS bg underneath.

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

// Two-octave, threshold-shaped bloom. Scale/offset pick the blob pattern;
// the smoothstep gives each bloom a soft shoulder rather than a hard edge.
float bloom(vec2 p, float scale, float offset) {
  float n = valueNoise(p * scale + vec2(offset, -offset * 0.6));
  return smoothstep(0.45, 0.68, n);
}

void main() {
  // 200 px per noise unit — blooms land at roughly panel scale.
  vec2 frag = vec2(vUv.x, 1.0 - vUv.y) * uResolution / 200.0;

  float drift = uTime * 0.02;
  vec2 sageOffset = vec2(drift, -drift * 0.7);
  vec2 terraOffset = vec2(-drift * 0.5, drift);

  float sageHere = bloom(frag + sageOffset, 0.6, 11.1);
  float terraHere = bloom(frag + terraOffset, 0.9, 37.3);

  // Finite-difference Sobel for the wet-edge rim. eps chosen small enough to
  // catch each bloom's shoulder but not so small it picks up noise jitter.
  float eps = 0.03;
  float sageR = bloom(frag + vec2(eps, 0.0) + sageOffset, 0.6, 11.1);
  float terraR = bloom(frag + vec2(eps, 0.0) + terraOffset, 0.9, 37.3);
  float sageU = bloom(frag + vec2(0.0, eps) + sageOffset, 0.6, 11.1);
  float terraU = bloom(frag + vec2(0.0, eps) + terraOffset, 0.9, 37.3);

  float fieldHere = sageHere * 0.5 + terraHere * 0.5;
  float fieldR = sageR * 0.5 + terraR * 0.5;
  float fieldU = sageU * 0.5 + terraU * 0.5;
  float edge = clamp(length(vec2(fieldR - fieldHere, fieldU - fieldHere)) * 7.0, 0.0, 1.0);

  vec3 color = uBgColor;
  color = mix(color, uPrimaryColor, sageHere * 0.40);
  color = mix(color, uSecondaryColor, terraHere * 0.32);
  // Wet edge = multiplicative darken of whatever color is present locally,
  // so the rim stays in the bloom's own hue family rather than going black.
  color = mix(color, color * 0.72, edge * 0.45);

  gl_FragColor = vec4(color, 0.82);
}
