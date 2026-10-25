precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform vec3 uBgColor;

// Cassette Futurism — 1970s Moog studio. Stripped to tape grain only:
// the warm bottom gradient (tube-amp filament wash), the VU-meter glow,
// and the corner vignette were all gradient-y and banded against
// near-black. What remains is fine horizontal tape streaks drifting
// right→left — magnetic tape passing a head. The walnut/orange palette
// lives in the theme tokens.

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 frag = vec2(vUv.x, 1.0 - vUv.y) * uResolution;

  // Tape grain — per-row noise drifting slowly so the "tape" appears
  // to move. mod() bounds the drift arg so the hash doesn't lose
  // precision over long uptime.
  float row = floor(frag.y);
  float drift = mod(uTime * 60.0, 8192.0);
  float tape = hash(vec2(floor((frag.x + drift) / 2.0), row * 0.5));
  // Sparse streaks only — keep the bright tail of the distribution.
  float streak = smoothstep(0.82, 0.98, tape) * 0.16;

  vec3 color = uSecondaryColor * streak;
  float alpha = clamp(streak * 1.0, 0.0, 0.22);

  gl_FragColor = vec4(color, alpha);
}
