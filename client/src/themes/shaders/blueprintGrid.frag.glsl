precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform vec3 uBgColor;

// Blueprint — engineering-drawing grid on deep navy.
//  1. Minor grid at 4px, major grid at 20px (= 5 × minor) in screen pixels so
//     the cell size doesn't change with viewport scale.
//  2. 1-px smoothstep edge per line so diagonal pans don't alias noisily.
//  3. Drafting-lamp radial gradient lifts the center toward a slightly lighter
//     navy, giving the field a "paper under a lamp" read instead of flat fill.
//  4. uTime intentionally unused — the grid is static (blueprints don't drift).

void main() {
  vec2 frag = vec2(vUv.x, 1.0 - vUv.y) * uResolution;

  float minorPeriod = 4.0;
  float majorPeriod = 20.0;

  vec2 minorMod = mod(frag, minorPeriod);
  vec2 majorMod = mod(frag, majorPeriod);

  // Polish pass round 2 (2026-04-18): still reading as "foreground pattern
  // competing with text". Edges softened further (1.8→1.2 minor, 2.2→1.6
  // major) and the minor/major mix terms are cut roughly in half again
  // below — grid now sits as a ghost watermark.
  float minorLine = max(
    smoothstep(1.2, 0.0, min(minorMod.x, minorPeriod - minorMod.x)),
    smoothstep(1.2, 0.0, min(minorMod.y, minorPeriod - minorMod.y))
  );
  float majorLine = max(
    smoothstep(1.6, 0.0, min(majorMod.x, majorPeriod - majorMod.x)),
    smoothstep(1.6, 0.0, min(majorMod.y, majorPeriod - majorMod.y))
  );

  // Drafting-lamp gradient — brighter at center
  vec2 p = vUv - 0.5;
  float r = length(p);
  float lamp = clamp(1.0 - r * 1.3, 0.0, 1.0);
  vec3 warmedBg = mix(uBgColor, uBgColor + vec3(0.03, 0.05, 0.08), lamp * 0.65);

  // Secondary color provides the brighter major-line accent so theme swaps
  // with the same 'blueprint-grid' preset could differentiate hierarchy.
  vec3 minorLineColor = uPrimaryColor;
  vec3 majorLineColor = mix(uPrimaryColor, uSecondaryColor, 0.35);

  vec3 color = warmedBg;
  // Mix weights halved again (0.11→0.05, 0.28→0.14) so the grid reads as
  // a ghost watermark rather than active linework.
  color = mix(color, minorLineColor, minorLine * 0.05);
  color = mix(color, majorLineColor, majorLine * 0.14);

  gl_FragColor = vec4(color, 0.85);
}
