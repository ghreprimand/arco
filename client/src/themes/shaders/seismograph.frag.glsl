precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;    // graphite line
uniform vec3 uSecondaryColor;  // rust (tension spikes)
uniform vec3 uBgColor;
uniform float uTension;

// SEISMOGRAPH — continuous graphite waveform scrolling horizontally across
// warm-grey paper. Layers:
//  1. Faint 10px grid (traced-paper rulings).
//  2. Three summed sine waves driving the main trace. Amplitude ramps with
//     uTension; base amplitude kept low so the calm register is near-flat.
//  3. Occasional spikes (envelope triggered by slow hash) — rust-tinted.
// Mood is warm-light and contemplative: the seismograph is quiet until
// something happens.

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 frag = vUv * uResolution;
  float mid = uResolution.y * 0.5;

  // Horizontal scroll speed in pixels/sec. Wrap x at a multiple of the
  // longest sine period (2π/0.018 ≈ 349 px) and of spikeW (340) so that
  // downstream sin() and floor(x/spikeW) see bounded inputs. Without the
  // wrap, x grows unbounded with uTime and both the sine phase and the
  // spike-index hash collapse once fractional precision is exhausted.
  float speed = 32.0;
  float x = mod(frag.x + uTime * speed, 116280.0); // 340 * 342, ~1hr at 32 px/s

  // Three sine components at different spatial frequencies + phases.
  float baseAmp = 2.5 + uTension * 28.0; // pixels
  float w = baseAmp * (
      sin(x * 0.018) * 0.6
    + sin(x * 0.047 + 1.3) * 0.3
    + sin(x * 0.103 + 2.1) * 0.1
  );

  // Spikes: every ~7s in x, a random amplitude envelope bumps the trace.
  // Sample a slow hash on floor(x/spikeW) to decide spike magnitude.
  float spikeW = 340.0;
  float spikeIdx = floor(x / spikeW);
  float spikeSeed = hash(vec2(spikeIdx, 1.0));
  float spikeLocal = fract(x / spikeW);
  // Spike envelope: narrow cosine bump, active only for high seeds.
  float spikeActive = smoothstep(0.85, 1.0, spikeSeed);
  float spikeEnv = exp(-pow((spikeLocal - 0.5) * 12.0, 2.0)) * spikeActive;
  float spikeSign = (hash(vec2(spikeIdx, 2.0)) > 0.5) ? 1.0 : -1.0;
  float spikeMag = 40.0 + spikeSeed * 60.0;
  float spike = spikeSign * spikeEnv * spikeMag * (0.6 + uTension * 0.8);

  float traceY = mid + w + spike;

  // Trace thickness. Core 1.2px + faint 4px halo.
  float d = abs(frag.y - traceY);
  float traceCore = smoothstep(1.6, 0.5, d);
  float traceHalo = smoothstep(5.0, 0.0, d) * 0.28;

  // Spike-scoped rust tint: blend primary (graphite) toward secondary (rust)
  // only near active spikes.
  float spikeTint = clamp(abs(spike) / 60.0, 0.0, 1.0) * 0.85;
  vec3 traceColor = mix(uPrimaryColor, uSecondaryColor, spikeTint);

  // --- Paper grid ---
  float gridMajor = smoothstep(0.6, 0.0, abs(mod(frag.x, 80.0) - 40.0) - 39.3)
                  + smoothstep(0.6, 0.0, abs(mod(frag.y, 80.0) - 40.0) - 39.3);
  float gridMinor = smoothstep(0.4, 0.0, abs(mod(frag.x, 20.0) - 10.0) - 9.4)
                  + smoothstep(0.4, 0.0, abs(mod(frag.y, 20.0) - 10.0) - 9.4);
  float grid = gridMajor * 0.06 + gridMinor * 0.025;

  // Fibre grain (very low amplitude).
  float grain = (hash(frag) - 0.5) * 0.012;

  // Output is added to paper (light theme). Accumulate darkening factors
  // rather than brightness — then alpha modulates how much the trace punches
  // through the body background.
  float ink = clamp(traceCore + traceHalo + grid, 0.0, 0.85);
  vec3 color = traceColor * (traceCore + traceHalo) + uPrimaryColor * grid + vec3(grain);

  // Return an additive-ish overlay. Higher alpha where ink is denser.
  gl_FragColor = vec4(color, ink);
}
