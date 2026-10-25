precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform vec3 uBgColor;

// Sakura petals — the cozy counterpart to Archon's otherwise intense shader
// set (ported in spirit from the Odysseus ambient-particle patterns,
// 2026-06-05). A sparse field of soft plum-blossom petals drifts down and
// sways side to side, each one slowly tumbling. Deliberately low-density and
// low-alpha: quiet ambient motion, not a snowstorm. Used by the `ume` theme.

float hash(float n) { return fract(sin(n) * 43758.5453); }
vec2 hash2(float n) { return vec2(hash(n), hash(n + 17.17)); }

// Soft, slightly elongated petal: an anisotropic Gaussian rotated by `ang`,
// with a faint notch so it reads as a petal rather than a dot.
float petal(vec2 frag, vec2 center, float size, float ang) {
  vec2 d = frag - center;
  float c = cos(ang), s = sin(ang);
  vec2 r = vec2(d.x * c - d.y * s, d.x * s + d.y * c);
  // Wider across, shorter along — a leaf-like footprint.
  r.x /= size * 1.6;
  r.y /= size * 0.9;
  float q = dot(r, r);
  float body = exp(-q);
  // Subtle tip notch (darkens the leading edge) for a petal silhouette.
  float notch = smoothstep(0.0, 1.2, r.y) * 0.25;
  return max(body - notch, 0.0);
}

void main() {
  vec2 frag = vec2(vUv.x, 1.0 - vUv.y) * uResolution;
  vec3 color = vec3(0.0);
  float alpha = 0.0;

  // Foreground petals — primary plum-pink. Sway amplitude scales with a
  // per-petal seed so they don't move in lockstep.
  for (int i = 0; i < 26; i++) {
    float fi = float(i);
    vec2 seed = hash2(fi * 1.61);
    float fall = 14.0 + seed.x * 18.0;
    float size = 5.0 + hash(fi + 2.2) * 5.0;
    float swayAmp = 22.0 + seed.y * 30.0;
    float swayF = 0.25 + hash(fi + 5.5) * 0.4;
    vec2 c;
    c.x = seed.x * uResolution.x + sin(uTime * swayF + fi * 2.3) * swayAmp;
    c.y = mod(seed.y * uResolution.y - uTime * fall, uResolution.y + 120.0) - 60.0;
    float ang = uTime * (0.3 + hash(fi + 7.1) * 0.5) + fi;
    float g = petal(frag, c, size, ang);
    float brightness = 0.5 + 0.5 * hash(fi + 9.3);
    color += uPrimaryColor * g * brightness;
    alpha += g * brightness * 0.7;
  }

  // Background petals — secondary wisteria, smaller, slower, fewer. Parallax
  // depth without clutter.
  for (int i = 0; i < 14; i++) {
    float fi = float(i);
    vec2 seed = hash2(fi * 2.93 + 53.0);
    float fall = 6.0 + seed.x * 9.0;
    float size = 3.0 + hash(fi + 1.1) * 2.5;
    vec2 c;
    c.x = seed.x * uResolution.x - sin(uTime * 0.2 + fi) * 14.0;
    c.y = mod(seed.y * uResolution.y - uTime * fall, uResolution.y + 60.0) - 30.0;
    float ang = uTime * 0.25 + fi * 1.7;
    float g = petal(frag, c, size, ang);
    color += uSecondaryColor * g * 0.3;
    alpha += g * 0.3 * 0.6;
  }

  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
}
