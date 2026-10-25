precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform vec3 uBgColor;
uniform float uTension;

// INFRARED — false-color thermogram, structural-only. The earlier
// noise-field thermal wash banded badly; the first rebuild over-corrected
// with a packed 28px cell grid that read as a checkerboard. This pass is
// sparse: large cells (60px), only ~12% lit at any moment, each lit cell
// holds a single thermo-mapped value with a hard edge so there's no
// gradient. Hot cells (amber/white) are rare. Cells fade in/out per their
// own per-cell schedule so the field reads as a quiet thermal scan.

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

vec3 thermo(float x) {
  x = clamp(x, 0.0, 1.0);
  vec3 c0 = vec3(0.02, 0.01, 0.08);
  vec3 c1 = vec3(0.12, 0.05, 0.40);
  vec3 c2 = vec3(0.75, 0.15, 0.55);
  vec3 c3 = vec3(1.00, 0.70, 0.18);
  vec3 c4 = vec3(1.00, 0.98, 0.88);
  if (x < 0.25) return mix(c0, c1, x / 0.25);
  if (x < 0.50) return mix(c1, c2, (x - 0.25) / 0.25);
  if (x < 0.75) return mix(c2, c3, (x - 0.50) / 0.25);
  return mix(c3, c4, (x - 0.75) / 0.25);
}

void main() {
  vec2 frag = vUv * uResolution;

  // Large cells, very sparse — the field reads as the occasional thermal
  // hit, not a heatmap. ~5% of cells lit at calm, up to ~12% at full
  // tension. Each lit cell fades in/out so flickers don't snap.
  float cellSize = 90.0;
  vec2 cellId = floor(frag / cellSize);
  vec2 cellUv = fract(frag / cellSize);

  float phase = hash(cellId);
  float bucket = floor(uTime * 0.18 + phase * 17.0);

  float litRoll = hash(cellId + vec2(bucket, 7.0));
  float litThresh = mix(0.95, 0.88, uTension);
  float lit = step(litThresh, litRoll);

  float value = hash(cellId + vec2(bucket, 11.0));
  value = pow(value, 2.4);

  float bucketPhase = fract(uTime * 0.18 + phase * 17.0);
  float fade = smoothstep(0.0, 0.20, bucketPhase) * smoothstep(1.0, 0.80, bucketPhase);

  vec3 color = thermo(value);

  // 4-px gap between cells.
  float pad = step(0.08, cellUv.x) * step(cellUv.x, 0.92)
            * step(0.08, cellUv.y) * step(cellUv.y, 0.92);

  float intensity = lit * fade * pad;
  float alpha = clamp(intensity * (0.10 + value * 0.10), 0.0, 0.18);

  gl_FragColor = vec4(color * intensity, alpha);
}
