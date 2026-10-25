precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;    // steel-blue accent
uniform vec3 uSecondaryColor;  // amber — corner pulse markers
uniform vec3 uBgColor;
uniform float uTension;

// SENTINEL — operator on shift. Stripped to its structural skeleton:
// four pulsing-amber diamond markers in the corners + luminance-aware
// grain. The atmospheric noise wash + radial vignette were removed
// because they banded against near-black at low alpha. Period of the
// corner pulse shortens with tension (3s calm → 0.8s crisis) so the
// theme still carries DARKN0DE's "watched over" register without a
// glowing wash.

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 frag = vUv * uResolution;
  vec3 color = vec3(0.0);
  float alpha = 0.0;

  // --- Corner pulse markers ---
  float period = mix(3.0, 0.8, uTension);
  float phase = uTime * 6.28318 / period;
  float pulse = 0.45 + 0.55 * sin(phase);

  float inset = 36.0;
  float d0 = abs(frag.x - inset)                   + abs(frag.y - inset);
  float d1 = abs(frag.x - (uResolution.x - inset)) + abs(frag.y - inset);
  float d2 = abs(frag.x - inset)                   + abs(frag.y - (uResolution.y - inset));
  float d3 = abs(frag.x - (uResolution.x - inset)) + abs(frag.y - (uResolution.y - inset));
  float dmin = min(min(d0, d1), min(d2, d3));

  float markerCore = smoothstep(10.0, 2.0, dmin);
  float markerGlow = smoothstep(48.0, 0.0, dmin) * 0.65;
  float marker = (markerCore + markerGlow) * pulse;
  color += uSecondaryColor * marker * 1.4;
  alpha += marker * 0.85;

  // --- Grain — luminance-aware, very subtle. Doubles as dither.
  float lum = dot(color, vec3(0.299, 0.587, 0.114));
  float grainSeed = hash(frag + fract(uTime * 37.0) * 1000.0) - 0.5;
  float grainStrength = 0.012 * (1.0 - lum * 0.75);
  color += vec3(grainSeed * 2.0 * grainStrength);
  alpha += abs(grainSeed) * 0.04;

  alpha = clamp(alpha, 0.0, 0.92);
  gl_FragColor = vec4(color, alpha);
}
