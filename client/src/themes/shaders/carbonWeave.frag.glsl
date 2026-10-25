precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform vec3 uBgColor;

// Stealth — cold luxury, carbon fiber. Two layers:
//  1. Carbon weave: subtle anisotropic cross-hatch pattern. The classic
//     2-over-2 twill weave has tiny rectangular tiles, each with a
//     diagonal fiber angle that alternates by row/column. We render a
//     cheap approximation with two sine gradients.
//  2. Specular drift: a soft elongated highlight slowly moves across the
//     surface at a shallow diagonal angle — like viewing angle shifting
//     on a real carbon panel.
// No flicker, no pulse. Cold and still.

void main() {
  vec2 frag = vec2(vUv.x, 1.0 - vUv.y) * uResolution;

  // Weave pattern — alternating 10x6 tiles. Each tile has a fiber angle.
  // We model it as two intersecting ridge patterns at ±22° that alternate
  // which is on top in a checkerboard layout.
  float tileX = floor(frag.x / 10.0);
  float tileY = floor(frag.y / 6.0);
  float checker = mod(tileX + tileY, 2.0);
  // Ridge along +22° and -22° axes
  vec2 axis1 = vec2(0.927, 0.375);   // cos(22), sin(22)
  vec2 axis2 = vec2(0.927, -0.375);
  float r1 = sin(dot(frag, axis1) * 0.9);
  float r2 = sin(dot(frag, axis2) * 0.9);
  // Checker selects which ridge shows on top this tile
  float ridge = mix(r1, r2, checker);
  // Map sine → subtle luminance variation (only slightly lighten highlights)
  float weave = smoothstep(0.2, 0.9, ridge) * 0.05;

  // Specular drift — a soft horizontal bar tilted slightly, moving right
  // across the screen once per 28s. The bar is wide (~30% of width) so
  // it reads as a highlight, not a scanline.
  vec2 specDir = normalize(vec2(1.0, 0.25));
  float specProj = dot(frag, specDir) / (uResolution.x + uResolution.y * 0.25);
  float specPhase = mod(uTime / 28.0, 1.3) - 0.15;
  float specD = specProj - specPhase;
  float spec = exp(-specD * specD / 0.018) * 0.18;

  // (Corner vignette removed — radial gradient banded against the dark base.)

  // Composite: weave + spec are both additive lightening, using the
  // secondary (safety orange) for the specular tint so it reads warm
  // against the cool teal primary palette.
  vec3 color = vec3(weave) + uSecondaryColor * spec * 0.6 + vec3(spec) * 0.3;
  float alpha = clamp(weave + spec * 0.8, 0.0, 0.55);

  gl_FragColor = vec4(color, alpha);
}
