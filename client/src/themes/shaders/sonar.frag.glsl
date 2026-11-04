precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;    // sonar green
uniform vec3 uSecondaryColor;  // pale green contact
uniform vec3 uBgColor;
uniform float uTension;

// SONAR — WWII ASDIC display, structural-only. Original sweep wedge +
// concentric ring grid + radial vignette were removed because the soft
// gradients banded against near-black at low alpha. What remains is
// what makes a sonar plot a sonar plot: the discrete contact returns —
// pinprick dots at fixed positions that flare brighter on a sweep
// schedule, then decay. Contacts always exist; only their brightness
// varies with the sweep cycle.

#define PI 3.14159265

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 frag = vUv * uResolution;

  // Sonar center: bottom-center.
  vec2 center = vec2(uResolution.x * 0.5, uResolution.y * 1.02);
  float screenR = uResolution.y * 1.05;

  // Sweep cycle drives contact flare timing.
  float sweepPeriod = mix(6.0, 2.0, uTension);
  float sweepAng = mod(uTime * 2.0 * PI / sweepPeriod, 2.0 * PI);

  // Six contacts at hashed positions. Each flares as the sweep crosses
  // its angular position, then decays over the cycle.
  float contact = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float cRad = 0.30 + hash(vec2(fi, 1.0)) * 0.55;
    float cAng = hash(vec2(fi, 2.0)) * 2.0 * PI;
    vec2 cPos = center + vec2(sin(cAng), -cos(cAng)) * cRad * screenR;
    float cD = length(frag - cPos);
    float trailAtContact = mod(sweepAng - cAng, 2.0 * PI);
    float decay = 1.0 - trailAtContact / (2.0 * PI);
    contact += smoothstep(8.0, 1.5, cD) * pow(decay, 1.6);
  }

  vec3 color = uSecondaryColor * contact * 1.2 + uPrimaryColor * contact * 0.4;
  float alpha = clamp(contact * 0.95, 0.0, 0.85);

  gl_FragColor = vec4(color, alpha);
}
