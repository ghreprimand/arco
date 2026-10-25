precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform vec3 uBgColor;
uniform float uTension;          // 0 = calm, 1 = crisis — scales rain speed
uniform sampler2D uAtlas;
uniform float uGlyphCount;
uniform float uCellPx;

// Matrix rain — phosphor cascade. Rewritten 2026-04-24: each column now has
// a trio of seeded variations on top of the base speed/length/phase: a
// glitch flag that occasionally speeds the column up + flashes the head
// bright, a mixed-hue flag that tints ~7% of columns toward the cyan
// secondary, and a per-column brightness multiplier so the field has a
// range of luminances rather than everything at one amplitude. Scanline
// + vignette now stack with a subtle edge chromatic smear so the whole
// field reads as a CRT that's actually *on* rather than a clean shader.

float hash(float n) { return fract(sin(n) * 43758.5453); }

vec4 rainAt(vec2 frag) {
  float col = floor(frag.x / uCellPx);

  // ~10% of columns sit empty so the field has gaps rather than a solid
  // wall (was 18% — thinned to make the cascade read more prominently).
  if (hash(col * 1.7 + 3.1) < 0.10) return vec4(0.0);

  // --- Per-column seeded variations ---
  float glitchSeed = hash(col + 29.7);
  float hueSeed    = hash(col + 41.3);
  float ampSeed    = hash(col + 53.9);

  // Glitch columns: ~9% of columns cycle in fast bursts with a long
  // visible flash window. Per-column phase offset so they fire unevenly
  // across the screen. Push 2026-04-24: bumped from 4% to 9%, flash
  // window doubled, speed multiplier raised — the operator noted the earlier pass
  // was barely detectable.
  float isGlitch = step(0.91, glitchSeed);
  float glitchPhase = mod(uTime * 0.5 + hash(col + 7.9) * 10.0, 10.0);
  float glitchActive = isGlitch * smoothstep(8.4, 8.8, glitchPhase) * smoothstep(9.98, 9.6, glitchPhase);
  float speedMult = mix(1.0, 4.2, glitchActive);

  // Mixed-hue columns: ~14% lean toward secondary cyan with heavier
  // blend ratio so the variation is visible without breaking theme unity.
  float isMixed = step(0.86, hueSeed);

  // Per-column brightness: 0.6 to 1.25. Combined with glitch flash this
  // gives the field real depth rather than a uniform plane of glyphs.
  float colBrightness = 0.6 + ampSeed * 0.65;

  // --- Rain computation ---
  float speed = (62.0 + hash(col + 11.1) * 92.0) * (1.0 + uTension * 0.6) * speedMult;
  float trailPx = 220.0 + hash(col + 5.5) * 220.0;
  float wrap = uResolution.y + trailPx + 100.0;
  float headY = mod(uTime * speed + hash(col + 17.3) * wrap, wrap) - trailPx;

  float dist = headY - frag.y;
  if (dist < -8.0 || dist > trailPx) return vec4(0.0);
  float clamped = max(dist, 0.0);

  // Sharper trail falloff — brights are brighter, darks die faster.
  float t = 1.0 - clamped / trailPx;
  float brightness = pow(t, 1.55);

  float row = floor(frag.y / uCellPx);
  float headRow = floor(headY / uCellPx);
  float glyphSeed;
  if (abs(row - headRow) < 0.5) {
    // Head row: glyph rotates faster so the leading edge flickers.
    // mod() keeps the seed bounded — without it the sin(seed*12.9898)
    // argument blows past usable fractional precision after long uptime
    // and the head-glyph stops cycling.
    glyphSeed = col * 0.137 + mod(floor(uTime * 7.0), 4096.0);
  } else {
    glyphSeed = col * 0.137 + row * 0.319 + mod(floor(uTime * 0.4 + row * 0.07), 4096.0);
  }
  float glyphIdx = floor(fract(sin(glyphSeed * 12.9898) * 43758.5453) * uGlyphCount);

  vec2 cellUv = fract(frag / uCellPx);
  float u = (glyphIdx + cellUv.x) / uGlyphCount;
  float v = 1.0 - cellUv.y;
  float lum = texture2D(uAtlas, vec2(u, v)).r;

  // --- Color: base primary, optionally mixed toward secondary ---
  vec3 trailColor = mix(uPrimaryColor, uSecondaryColor, isMixed * 0.55);
  // Head pushed hard to near-white so the leading glyph punches through.
  vec3 headColor  = mix(trailColor, vec3(1.0), 0.92);
  float headBoost = smoothstep(0.90, 1.0, t);
  vec3 color = mix(trailColor, headColor, headBoost);

  // Glitch flash: during an active glitch, saturate the whole column
  // toward white (not just the head). Bigger vertical range so the
  // flash is actually visible, not just a head blink.
  color += vec3(0.85) * glitchActive * max(headBoost, t * 0.4);

  float a = brightness * lum * colBrightness;
  return vec4(color * a, a);
}

void main() {
  vec2 frag = vec2(vUv.x, 1.0 - vUv.y) * uResolution;

  // Triple sample for vertical anti-aliasing.
  vec4 c = rainAt(frag) * 0.52
         + rainAt(frag + vec2(0.0, -1.4)) * 0.24
         + rainAt(frag + vec2(0.0,  1.4)) * 0.24;

  // --- Scanlines ---
  // Deeper fine scanline amplitude so the CRT raster reads clearly; slow
  // breathing still modulates so the field doesn't feel static.
  float scanFine = 0.84 + 0.16 * sin(frag.y * 3.14159 * 0.9);
  float scanSlow = 0.95 + 0.05 * sin(uTime * 1.3 + frag.y * 0.01);
  float scan = scanFine * scanSlow;

  // --- Vignette — dual-ring, tightened for a CRT-tube feel ---
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  float vig = 1.0 - r2 * 0.46 - smoothstep(0.60, 1.45, r2) * 0.45;
  vig = clamp(vig, 0.0, 1.0);

  // (Edge chromatic smear removed — was producing ghost columns next to
  // every rain stream and reading as a halo around each column.)

  gl_FragColor = vec4(c.rgb * scan * vig, c.a * scan * vig);
}
