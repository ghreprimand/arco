precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;    // bright caustic cyan
uniform vec3 uSecondaryColor;  // pale bubble-blue
uniform vec3 uBgColor;
uniform float uTension;

// CHERENKOV — you are watching a reactor through the cooling pool.
// Caustics + vignette removed: any noise-field gradient banded badly
// against near-black at low alpha. What's left is the structural part:
// rising bubble streaks ascending from below. Color identity lives in the
// token palette and the bubble tint.

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  // --- Rising bubble streaks — column-based, structural.
  vec2 frag = vUv * uResolution;
  float colW = 95.0;
  float col = floor(frag.x / colW);
  float colSeed = hash(vec2(col, 0.0));
  float bubblePeriod = 11.0;
  float bubbleLocal = mod(uTime + colSeed * bubblePeriod, bubblePeriod);
  float bubbleLife = 3.0;
  float bubbleActive = step(bubbleLocal, bubbleLife) * step(colSeed, 0.72);
  float bubbleY = uResolution.y - (bubbleLocal / bubbleLife) * uResolution.y;
  float colCenter = (col + 0.5) * colW + (hash(vec2(col, 1.0)) - 0.5) * colW * 0.7;
  float bubbleDX = frag.x - colCenter;
  float bubbleDY = frag.y - bubbleY;
  float bubbleShape =
    exp(-(bubbleDX * bubbleDX) / 22.0) *
    smoothstep(58.0, 0.0, abs(bubbleDY)) *
    smoothstep(3.0, 0.0, bubbleDY);
  float bubble = bubbleShape * bubbleActive * 0.85;

  vec3 color = uSecondaryColor * bubble * 1.1
             + uPrimaryColor * bubble * 0.25;
  float alpha = clamp(bubble * 0.9, 0.0, 0.85);

  gl_FragColor = vec4(color, alpha);
}
