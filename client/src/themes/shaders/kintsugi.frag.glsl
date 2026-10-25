precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;    // warm gold
uniform vec3 uSecondaryColor;  // pale ivory / moonlight
uniform vec3 uBgColor;
uniform float uTension;

// KINTSUGI — dark urushi lacquer with slow, quiet gold veins. Built on
// Worley-style feature-point distance: each pixel measures how close it is
// to the cell boundaries of a jittered point grid. Boundaries read as
// cracks. Time slowly morphs the jitter so the cracks breathe. Extremely
// low alpha everywhere but the crack lines, so body text stays readable
// over near-black lacquer.

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

vec2 hash2(vec2 p) {
  return fract(sin(vec2(
    dot(p, vec2(127.1, 311.7)),
    dot(p, vec2(269.5, 183.3))
  )) * 43758.5453);
}

// Returns distance to the boundary between the two closest feature points.
// The narrower the gap between 1st and 2nd nearest, the closer the pixel
// is to an edge — which is where cracks live.
float worleyEdge(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 n = vec2(float(x), float(y));
      vec2 jitter = hash2(i + n);
      // Slow animated jitter so cracks morph without flying around.
      jitter += 0.15 * vec2(
        sin(uTime * 0.13 + hash(i + n) * 6.28),
        cos(uTime * 0.11 + hash(i + n) * 6.28)
      );
      vec2 r = n + jitter - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; }
      else if (d < d2) { d2 = d; }
    }
  }
  return sqrt(d2) - sqrt(d1);
}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);

  // Coarse base pattern (big cracks).
  float e1 = worleyEdge(vUv * 3.5);
  // Finer traceries, weaker.
  float e2 = worleyEdge(vUv * 8.0 + vec2(11.0, 3.0));

  // Convert edge-distance to a thin line intensity. Smaller = brighter.
  // Tighter falloff so veins read as filaments instead of soft glows.
  float vein1 = smoothstep(0.05, 0.0, e1);
  float vein2 = smoothstep(0.03, 0.0, e2) * 0.50;
  float vein = max(vein1, vein2);

  // Slower, smaller amplitude wash so the field doesn't visibly pulse.
  float breathe = 0.78 + 0.18 * sin(uTime * 0.21);
  vein *= breathe;

  // Subtle gold shimmer — pale-ivory highlight along the brightest cracks.
  float sparkle = smoothstep(0.82, 1.0, vein);
  vec3 color = uPrimaryColor * vein * 0.55
             + uSecondaryColor * sparkle * 0.40;

  // (Lacquer-depth vignette removed — radial gradient banded.)
  float alpha = clamp(vein * 0.50, 0.0, 0.45);
  gl_FragColor = vec4(color, alpha);
}
