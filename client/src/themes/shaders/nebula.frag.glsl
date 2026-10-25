precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;    // violet / magenta star-cloud
uniform vec3 uSecondaryColor;  // cyan-indigo nebula
uniform vec3 uBgColor;
uniform float uTension;

// NEBULA — Hubble deep field. Dense slowly-drifting starfield at fixed
// brightness (no shimmer). Each star has a hashed velocity so the field
// reads as gentle parallax rather than a static plate. ~14% of stars are
// tinted toward primary/secondary so the violet/cyan identity reads.

float hash(float n) { return fract(sin(n) * 43758.5453); }
vec2 hash2(float n) { return vec2(hash(n), hash(n + 91.7)); }

void main() {
  vec2 frag = vec2(vUv.x, 1.0 - vUv.y) * uResolution;
  vec3 color = vec3(0.0);
  float alpha = 0.0;

  // 140 stars — denser than aurora since this is "deep field". Per-star
  // drift: small slow random velocity, fixed brightness.
  for (int i = 0; i < 140; i++) {
    float fi = float(i);
    vec2 seed = hash2(fi * 2.71);
    float ang = hash(fi + 4.4) * 6.28318;
    float speed = 0.7 + hash(fi + 6.6) * 2.0;
    vec2 vel = vec2(cos(ang), sin(ang)) * speed;
    vec2 c = mod(seed * vec2(uResolution.x, uResolution.y) + vel * uTime,
                 vec2(uResolution.x, uResolution.y));
    float d = length(frag - c);
    float size = 0.7 + hash(fi + 9.9) * 0.6;
    float s = exp(-d * d / (size * size));

    // Most stars warm-cream; a fraction tinted toward the violet/cyan palette.
    float tintRoll = hash(fi + 13.7);
    vec3 tinted = mix(uPrimaryColor, uSecondaryColor, hash(fi + 19.4));
    vec3 starColor = mix(vec3(0.95, 0.92, 0.85), tinted * 1.15, step(0.86, tintRoll));
    color += starColor * s;
    alpha += s;
  }

  alpha = clamp(alpha * 0.95, 0.0, 0.92);
  gl_FragColor = vec4(color, alpha);
}
