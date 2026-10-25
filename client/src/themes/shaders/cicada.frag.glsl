precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;    // dim cryptic green
uniform vec3 uSecondaryColor;  // occasional flash-white
uniform vec3 uBgColor;
uniform float uTension;

// CICADA — cryptic data stream. An LCD-like grid of cells, each cell either
// lit or dark per-frame according to a hash of (column, row-bucket, time).
// Row buckets scroll downward continuously, giving a sense of streaming
// data without the heaviness of the matrix atlas pipeline. Occasional rare
// cells flash pale (the "anomaly"). Very low peak alpha — the theme is
// meant to be readable over chat, not dominate it.

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 frag = vUv * uResolution;

  // Cell size tuned so the "hex dump" reads at roughly character density
  // of JetBrains Mono at 13px, without actually being characters.
  float cw = 9.0;
  float ch = 14.0;

  // Scroll columns downward at a column-specific speed.
  float col = floor(frag.x / cw);
  float colSpeed = 18.0 + hash(vec2(col, 0.1)) * 28.0;
  float yScroll = frag.y + uTime * colSpeed;

  // Row bucket in scrolled space. Wrap before feeding into hash() so the
  // input stays bounded — otherwise row grows unbounded with uTime and the
  // hash (fract(sin(dot(...) * 43758))) collapses once the argument exceeds
  // the GPU's usable fractional range, making the cell field freeze or go
  // dark after minutes-to-hours of uptime.
  float row = mod(floor(yScroll / ch), 4096.0);

  // Per-cell seed.
  float seed = hash(vec2(col, row));

  // Lit probability ~0.45 calm, rises with tension. Denser field reads
  // as an actual data stream instead of scattered dots.
  float litThresh = 0.55 - uTension * 0.12;
  float lit = step(litThresh, seed);

  // Anomaly — flash-white. Back off from the deck-out rate (0.9975) since
  // the constellation of white flashes was reading as too busy; 0.9988 is
  // ~2× the original frequency, frequent enough to notice but not busy.
  float anomaly = step(0.9988, seed);

  // Inside-cell shaping: 3x5 dot grid pretending to be glyph pixels.
  // Use cell-local coords 0..1 and threshold a hash at subgrid resolution
  // so each lit cell has a unique "bit" pattern rather than a uniform block.
  vec2 cellUv = vec2(fract(frag.x / cw), fract(yScroll / ch));
  vec2 sub = floor(cellUv * vec2(3.0, 5.0));
  float subSeed = hash(vec2(col * 3.0 + sub.x, row * 5.0 + sub.y));
  float subLit = step(0.52, subSeed);
  // 1px padding inside each cell so cells don't touch.
  float pad = step(0.06, cellUv.x) * step(cellUv.x, 0.94)
            * step(0.05, cellUv.y) * step(cellUv.y, 0.95);
  float cellBody = subLit * pad;

  // Brightness falls off near the top of the viewport (as rows have just
  // spawned) and brightens mid-screen — subtle vertical gradient.
  float vFade = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.15, 0.35, vUv.y);

  // Dialled back 2026-04-24 — the operator flagged the deck-out pass as too bright.
  // Density (lit threshold, anomaly frequency) kept at the fuller values
  // because the stream needs to read as a data stream; just the per-cell
  // brightness, anomaly pop, and alpha cap pulled back toward the original
  // barely-perceptible register.
  // Cells dim enough that the bloom-overlay's screen-blend contribution
  // doesn't paint a visible texture across the whole viewport, but
  // bumped slightly back from the over-corrected pass — the cells need
  // to read as data stream, not whisper.
  float brightness = lit * cellBody * vFade * 0.32;
  vec3 color = uPrimaryColor * brightness;

  color += uSecondaryColor * anomaly * cellBody * 0.60;

  float alpha = clamp(brightness * 0.95 + anomaly * cellBody * 0.65, 0.0, 0.40);
  gl_FragColor = vec4(color, alpha);
}
