precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform vec3 uBgColor;
uniform float uTension;

// Noir — film grain only. The corner vignette was removed: smooth radial
// gradients band visibly when composited at low alpha against near-black.
// What remains is two octaves of grain (fine + coarse) animated so the
// whole field shimmers like passing 35mm. The crimson accent lives in
// theme tokens, not here.

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 frag = vec2(vUv.x, 1.0 - vUv.y) * uResolution;

  // Two octaves of grain. mod() wraps the time arg so fract(sin(...))
  // doesn't lose precision after long uptime.
  float fine = hash(frag + vec2(mod(uTime * 60.0, 4096.0), mod(uTime * 43.0, 4096.0)));
  float coarse = hash(floor(frag / 3.0) + vec2(mod(uTime * 20.0, 4096.0), mod(uTime * 15.0, 4096.0)));
  float grain = mix(fine, coarse, 0.35);
  float g = (grain - 0.5) * (0.10 + uTension * 0.06);

  vec3 col = g >= 0.0 ? vec3(1.0) : vec3(0.0);
  float alpha = clamp(abs(g) * 0.30, 0.0, 0.20);

  gl_FragColor = vec4(col, alpha);
}
