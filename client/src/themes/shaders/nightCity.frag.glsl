precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;    // window sodium/tungsten yellow
uniform vec3 uSecondaryColor;  // street-lamp white
uniform vec3 uBgColor;
uniform float uTension;

// NIGHT CITY — aerial view of a sleeping city grid at night. Abstract:
//  1. City-block base: a coarse rect grid filled with darker-than-bg cells
//     so "streets" read as faint lighter gridlines between blocks.
//  2. Lit windows: inside each block, a fine dot-grid of pixel windows,
//     each independently lit with low probability and occasionally
//     flickering (hash(col,row,floor(time/interval))).
//  3. Traffic: pinprick dots scrolling along horizontal and vertical
//     thoroughfares at a few specific grid coordinates, tuned to appear
//     continuous without overwhelming the scene.

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 frag = vUv * uResolution;
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);

  // --- City blocks ---
  float blockSize = 120.0;
  vec2 blockId = floor(frag / blockSize);
  vec2 blockUv = fract(frag / blockSize);
  // Gridlines (streets).
  float streetX = smoothstep(0.03, 0.0, min(blockUv.x, 1.0 - blockUv.x));
  float streetY = smoothstep(0.03, 0.0, min(blockUv.y, 1.0 - blockUv.y));
  float street = max(streetX, streetY) * 0.10;

  // --- Windows inside each block — denser grid, more lit cells.
  float winGridX = 10.0;
  float winGridY = 8.0;
  vec2 winCell = floor(blockUv * vec2(winGridX, winGridY));
  vec2 winLocal = fract(blockUv * vec2(winGridX, winGridY));
  float winSeed = hash(blockId * 13.0 + winCell);
  float flickerBucket = floor(uTime * 0.3 + winSeed * 17.0);
  float flickerSeed = hash(blockId * 13.0 + winCell + vec2(flickerBucket, 0.7));
  // Lit threshold raised so the block tiling reads quieter — ~15% lit.
  float windowLit = step(0.85, winSeed) * step(0.20, flickerSeed);
  float winShape = step(0.26, winLocal.x) * step(winLocal.x, 0.74)
                 * step(0.28, winLocal.y) * step(winLocal.y, 0.72);
  float window = windowLit * winShape;

  // --- Traffic: moving dots on specific streets. Two horizontal + two
  // vertical thoroughfares per screen, chosen by hashed block rows/cols. ---
  float traffic = 0.0;
  for (int i = 0; i < 2; i++) {
    // Horizontal
    float hRow = floor(hash(vec2(float(i), 9.3)) * (uResolution.y / blockSize)) + 0.5;
    float hSpeed = 55.0 + hash(vec2(float(i), 9.4)) * 35.0;
    float hOff = mod(uTime * hSpeed + hash(vec2(float(i), 9.5)) * uResolution.x, uResolution.x);
    float hDX = frag.x - hOff;
    float hDY = frag.y - hRow * blockSize;
    traffic += exp(-(hDX * hDX) / 18.0 - (hDY * hDY) / 6.0);
    // Vertical
    float vCol = floor(hash(vec2(float(i), 3.1)) * (uResolution.x / blockSize)) + 0.5;
    float vSpeed = 55.0 + hash(vec2(float(i), 3.2)) * 35.0;
    float vOff = mod(uTime * vSpeed + hash(vec2(float(i), 3.3)) * uResolution.y, uResolution.y);
    float vDX = frag.x - vCol * blockSize;
    float vDY = frag.y - vOff;
    traffic += exp(-(vDX * vDX) / 6.0 - (vDY * vDY) / 18.0);
  }

  // --- Compose — pulled back another notch. Windows are a hint, traffic
  // still pops because it moves.
  vec3 color = uPrimaryColor * (window * 0.55 + street * 0.16)
             + uSecondaryColor * traffic * 0.78;

  // (Aerial vignette removed — radial gradient banded.)
  float alpha = clamp(window * 0.50 + street * 0.16 + traffic * 0.78, 0.0, 0.52);
  gl_FragColor = vec4(color, alpha);
}
