precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform vec3 uBgColor;

// Oscilloscope — the CRT tube itself. Two structural effects only:
//  1. Barrel distortion so the screen bulges (a hard cutoff outside the
//     tube face — no soft gradient).
//  2. Fine scanlines — every other row dimmed, classic phosphor texture.
// All radial vignettes / phosphor washes are gone (they banded). The
// text glow on UI characters lives in CSS via text-shadow on
// data-theme="oscilloscope".

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  vec2 warped = p * (1.0 + r2 * 0.11);
  vec2 uvW = warped * 0.5 + 0.5;

  // Outside the warped face → CRT bezel (hard step, no gradient).
  if (uvW.x < 0.0 || uvW.x > 1.0 || uvW.y < 0.0 || uvW.y > 1.0) {
    gl_FragColor = vec4(uBgColor, 0.95);
    return;
  }

  vec2 frag = vec2(uvW.x, 1.0 - uvW.y) * uResolution;

  // Scanlines — bright rows brighter, dim rows darker. Hard sin pattern,
  // not a smooth gradient — no banding.
  float line = 0.5 + 0.5 * sin(frag.y * 3.14159 * 1.0);
  float scanLit = pow(line, 1.4) * 0.06;

  vec3 color = uPrimaryColor * scanLit;
  float alpha = clamp(scanLit * 1.4, 0.0, 0.30);

  gl_FragColor = vec4(color, alpha);
}
