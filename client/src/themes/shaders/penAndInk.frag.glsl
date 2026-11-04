precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;    // ivy
uniform vec3 uSecondaryColor;  // gilt / candle gold
uniform vec3 uBgColor;         // walnut

// Dark Academia — candle-lit library. Two layered effects:
//  1. Radial candle glow, centered, with a slow flicker on uTime. Warms the
//     parchment toward secondary (gilt) and falls off to the deep walnut bg
//     at the corners.
//  2. Screen-space cross-hatching at ~7 px pitch, two angles (+45° / −45°).
//     Hatch density is driven by the local "darkness" derived from the candle
//     falloff — shadowy corners get denser hatching (both angles engaged),
//     lit center gets none. Reads as a pen-and-ink wash illustration rather
//     than a regular checkerboard.

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

void main() {
  vec2 frag = vec2(vUv.x, 1.0 - vUv.y) * uResolution;

  // Candle glow with slow flicker — two incommensurate sines keep it
  // irregular without strobing.
  vec2 p = vUv - 0.5;
  float r = length(p);
  float flicker = 1.0 + 0.06 * sin(uTime * 3.1) * sin(uTime * 7.7);
  float candle = clamp(1.0 - r * 1.55, 0.0, 1.0) * flicker;

  // Darkness driver + a splash of large-scale noise so the hatch density
  // isn't perfectly radial (library light is never even).
  float darkness = 1.0 - candle;
  darkness += (valueNoise(frag * 0.006) - 0.5) * 0.2;
  darkness = clamp(darkness, 0.0, 1.0);

  // Cross-hatching at ~7 px pitch
  float pitch = 7.0;
  float twoPi = 6.2831853;
  float phase1 = (frag.x + frag.y) * (twoPi / pitch);
  float phase2 = (frag.x - frag.y) * (twoPi / pitch);
  float hatch1 = 0.5 + 0.5 * sin(phase1);
  float hatch2 = 0.5 + 0.5 * sin(phase2);
  float line1 = smoothstep(0.55, 0.88, hatch1);
  float line2 = smoothstep(0.55, 0.88, hatch2);

  // Layer-2 (cross) only engages where it's genuinely dark — single hatching
  // reads as midtone, cross-hatching as shadow. Light center stays clean.
  float ink = line1 * smoothstep(0.35, 0.55, darkness)
            + line2 * smoothstep(0.60, 0.80, darkness);
  ink = clamp(ink, 0.0, 1.0);

  // Parchment: walnut lifted toward gilt by candle.
  vec3 parchment = mix(uBgColor, uSecondaryColor, candle * 0.35);
  // Ink color: muted ivy (primary) darkened so strokes read as ink, not moss.
  vec3 inkColor = uPrimaryColor * 0.55;
  vec3 color = mix(parchment, inkColor, ink * 0.5);

  gl_FragColor = vec4(color, 0.85);
}
