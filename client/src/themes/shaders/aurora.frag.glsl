precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;    // aurora green
uniform vec3 uSecondaryColor;  // magenta fringe
uniform vec3 uBgColor;
uniform float uTension;

// AURORA — arctic night sky. Slowly drifting stars at fixed brightness
// (no twinkle). Each star has a hashed direction + speed, wrapping around
// the viewport. Most stars are pale white; ~12% are tinted with the
// aurora-green / magenta palette so the polar register reads.

float hash(float n) { return fract(sin(n) * 43758.5453); }
vec2 hash2(float n) { return vec2(hash(n), hash(n + 91.7)); }

void main() {
  vec2 frag = vec2(vUv.x, 1.0 - vUv.y) * uResolution;
  vec3 color = vec3(0.0);
  float alpha = 0.0;

  // 90 stars drifting on individual hashed velocities across the whole
  // viewport. No twinkle — fixed brightness per star.
  for (int i = 0; i < 90; i++) {
    float fi = float(i);
    vec2 seed = hash2(fi * 3.17);
    // Per-star drift direction + speed.
    float ang = hash(fi + 5.5) * 6.28318;
    float speed = 1.5 + hash(fi + 8.8) * 3.5;
    vec2 vel = vec2(cos(ang), sin(ang)) * speed;
    vec2 c = mod(seed * vec2(uResolution.x, uResolution.y) + vel * uTime,
                 vec2(uResolution.x, uResolution.y));
    float d = length(frag - c);
    float size = 0.9 + hash(fi + 12.1) * 0.8;
    float s = exp(-d * d / (size * size));

    // Most stars pale white; some tinted toward primary/secondary.
    float tintRoll = hash(fi + 17.3);
    vec3 tinted = mix(uPrimaryColor, uSecondaryColor, hash(fi + 23.1));
    vec3 starColor = mix(vec3(0.92, 0.94, 0.96), tinted * 1.10, step(0.88, tintRoll));
    color += starColor * s;
    alpha += s;
  }

  alpha = clamp(alpha * 0.85, 0.0, 0.85);
  gl_FragColor = vec4(color, alpha);
}
