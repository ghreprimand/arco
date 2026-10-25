precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform vec3 uBgColor;

// Abyssal — marine snow. A field of bioluminescent particles drifts slowly
// downward under a faint horizontal current. A distant diffuse glow passes
// beneath them every ~24s like a gulper coming up from the trench. No
// scanlines, no grid — silence.

float hash(float n) { return fract(sin(n) * 43758.5453); }
vec2 hash2(float n) { return vec2(hash(n), hash(n + 17.17)); }

float particle(vec2 frag, vec2 center, float size) {
  float d = length(frag - center);
  // Soft Gaussian-ish falloff so particles feel hazy, not crisp
  return exp(-d * d / (size * size));
}

void main() {
  vec2 frag = vec2(vUv.x, 1.0 - vUv.y) * uResolution;
  vec3 color = vec3(0.0);
  float alpha = 0.0;

  // Near field — primary bioluminescent cyan. Slow drift, slight sway.
  for (int i = 0; i < 38; i++) {
    float fi = float(i);
    vec2 seed = hash2(fi * 1.37);
    float speed = 10.0 + seed.x * 14.0;
    float size = 2.0 + hash(fi + 3.3) * 3.5;
    vec2 c;
    c.x = seed.x * uResolution.x + sin(uTime * 0.18 + fi) * 18.0;
    c.y = mod(seed.y * uResolution.y - uTime * speed, uResolution.y + 80.0) - 40.0;
    float g = particle(frag, c, size);
    float brightness = 0.45 + 0.55 * hash(fi + 9.9);
    color += uPrimaryColor * g * brightness;
    alpha += g * brightness;
  }

  // Far field — tiny lilac flecks drifting the opposite way, far slower.
  // Gives a parallax suggestion without adding visual noise.
  for (int i = 0; i < 24; i++) {
    float fi = float(i);
    vec2 seed = hash2(fi * 2.71 + 91.0);
    float speed = 3.0 + seed.x * 5.0;
    float size = 1.2 + hash(fi + 4.4) * 1.6;
    vec2 c;
    c.x = seed.x * uResolution.x - sin(uTime * 0.09 + fi * 0.7) * 8.0;
    c.y = mod(seed.y * uResolution.y - uTime * speed, uResolution.y + 40.0) - 20.0;
    float g = particle(frag, c, size);
    color += uSecondaryColor * g * 0.35;
    alpha += g * 0.35;
  }

  // (Distant bloom blob + depth gradient removed — both produced visible
  // banding. The particle field alone now carries Abyssal.)

  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
}
