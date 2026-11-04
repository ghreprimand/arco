precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform vec3 uBgColor;

// DSKY — Apollo Guidance Computer. Stripped to raster bands only — the
// EL bloom blob and corner-bezel vignette banded badly. What remains is
// a faint horizontal trace pattern (the EL segment grid is built of
// glowing horizontal traces) plus a slow supply-ripple flicker so the
// panel reads as "lit" without painting any soft gradient. Per-character
// text glow lives in CSS on data-theme="dsky".

float hash(float n) { return fract(sin(n) * 43758.5453); }

void main() {
  vec2 frag = vUv * uResolution;

  // Horizontal raster traces. Hard sin pattern, no smooth gradient.
  float band = 0.5 + 0.5 * sin(frag.y * 3.14159 * 0.66);
  float trace = pow(band, 1.4) * 0.08;

  // Supply-ripple flicker — coarser quantization than film grain.
  float flickerStep = floor(uTime * 9.0);
  float flicker = 1.0 + (hash(flickerStep) - 0.5) * 0.10;

  vec3 color = uPrimaryColor * trace * flicker;
  float alpha = clamp(trace * 1.6, 0.0, 0.32);

  gl_FragColor = vec4(color, alpha);
}
