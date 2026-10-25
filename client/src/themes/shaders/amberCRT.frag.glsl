precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform vec3 uBgColor;

// Amber CRT — no falling glyphs. Four layered effects:
//  1. Barrel distortion: UVs are warped outward toward the corners so the
//     "screen" looks like a tube face. Pixels that warp off-grid render as
//     CRT bezel (dark bg).
//  2. Scanlines: a sin wave modulated over the y-axis produces the classic
//     fine-line amber flicker texture. We bias alpha toward dim rows so the
//     lines read as darker bands over the UI, not bright ones.
//  3. Corner vignette: radial falloff darkens the edges.
//  4. Slow rolling hum bar: a thin amber highlight drifts downward at a
//     steady rate to evoke a mains-coupled refresh rollbar.

void main() {
  // Barrel distortion — pushed harder (0.07 → 0.12) so the curvature
  // actually reads as a tube face.
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  vec2 warped = p * (1.0 + r2 * 0.12);
  vec2 uvW = warped * 0.5 + 0.5;

  // Outside the warped viewport → CRT bezel
  if (uvW.x < 0.0 || uvW.x > 1.0 || uvW.y < 0.0 || uvW.y > 1.0) {
    gl_FragColor = vec4(uBgColor, 0.92);
    return;
  }

  vec2 frag = vec2(uvW.x, 1.0 - uvW.y) * uResolution;

  // Scanlines — push the contrast: bright lines burn brighter, dim
  // bands dip deeper. Deck-out 2026-04-24.
  float line = 0.5 + 0.5 * sin(frag.y * 3.14159 * 0.9);
  float scanGlow = pow(line, 2.4);
  float scanDark = 1.0 - line;

  // (Vignette + global ambient wash removed — both produced banding on
  // the dark base. The amber identity now lives in the scanlines + hum
  // bar + token palette only.)

  // Slow rolling hum bar (period ~10s) — brighter peak.
  float humY = fract((frag.y / uResolution.y) - uTime * 0.10);
  float hum = smoothstep(0.0, 0.03, humY) * (1.0 - smoothstep(0.03, 0.14, humY));

  // Amber phosphor mix.
  vec3 phosphor = mix(uPrimaryColor, uSecondaryColor, scanGlow * 0.65);

  float highlight = scanGlow * 0.30 + hum * 0.40;
  float dimBand = scanDark * 0.18;

  vec3 color = phosphor * highlight;
  float alpha = clamp(highlight + dimBand, 0.0, 0.42);

  gl_FragColor = vec4(color, alpha);
}
