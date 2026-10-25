precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;    // sky blue #00a8e8
uniform vec3 uSecondaryColor;  // mint #7dd3a0
uniform vec3 uBgColor;         // pale sky #d6eaf5

// Frutiger Aero — Vista-era cloudscape + gradient mesh. Three layers:
//
//  1. Vertical sky gradient — brighter near the top, settling toward bg at
//     the bottom. Gives the "high-altitude over pale sky" read regardless
//     of where panels sit.
//  2. Two big slow-drifting blooms — one primary-tinted sky, one mint. Value
//     noise at coarse scale + smoothstep shoulder, same bloom()/valueNoise()
//     structure as watercolor.frag. Drift is slow (uTime * 0.015) — Aero
//     wallpapers feel composed, not animated.
//  3. Sparkle highlight — small bright specular spots at very low density
//     to suggest gloss without looking like stars. Thresholded noise, just
//     enough to catch the eye on a white surface.
//
// Output alpha 0.78 — the canvas sits at opacity 0.32, so effective contribution
// is ~25%. The rest comes from the CSS bg + translucent panels.

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

float bloom(vec2 p, float scale, float offset) {
  float n = valueNoise(p * scale + vec2(offset, -offset * 0.6));
  return smoothstep(0.42, 0.72, n);
}

void main() {
  // 260 px per noise unit — larger scale than watercolor so blooms feel
  // like clouds drifting across a vista rather than pooled pigment.
  vec2 frag = vec2(vUv.x, 1.0 - vUv.y) * uResolution / 260.0;

  // Vertical sky gradient — subtle lift toward top, darkens toward bottom by
  // ~12%. uBgColor already sits near sky-blue so the base is mostly a tint
  // shift, not a hue shift.
  float sky = mix(0.88, 1.08, vUv.y);
  vec3 base = uBgColor * sky;

  float drift = uTime * 0.015;
  vec2 aquaOffset = vec2(drift, -drift * 0.7);
  vec2 mintOffset = vec2(-drift * 0.45, drift * 0.8);

  float aqua = bloom(frag + aquaOffset, 0.55, 9.3);
  float mint = bloom(frag + mintOffset, 0.75, 41.7);

  vec3 color = base;
  color = mix(color, uPrimaryColor, aqua * 0.32);
  color = mix(color, uSecondaryColor, mint * 0.22);

  // Sparkle — high-frequency noise, thresholded hard. Density low enough that
  // most pixels see zero; bright enough to read as a specular glint when they
  // do. uTime warps the pattern slowly so sparkles aren't perfectly static.
  float sparkleField = valueNoise(frag * 12.0 + vec2(uTime * 0.08, -uTime * 0.06));
  float sparkle = smoothstep(0.93, 0.97, sparkleField);
  color += vec3(1.0) * sparkle * 0.22;

  gl_FragColor = vec4(color, 0.78);
}
