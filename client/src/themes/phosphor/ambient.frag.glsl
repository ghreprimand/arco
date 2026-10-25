// Adapted from the reference terminal crt.js, d52d430. No time-driven scan/band/hum.

    precision highp float;

    // Static ambient field; pointer decay is the only animation.
    uniform vec3 tint;
    uniform vec3 cold;
    uniform vec3 baseColor;
    uniform vec2 resolution;
    uniform float hoverArchive;
    uniform float hoverKill9;
    uniform float hoverCrossette;
    uniform float hoverSystems;
    uniform vec2 mouse;
    uniform float beam;
    varying vec2 vUv;

    float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    void main() {
        vec2 uv = vUv;
        vec2 p = uv - 0.5;
        vec2 glass = p * vec2(0.88, 1.18);

        // Soft floor so screen corners keep a hint of lit phosphor instead of
        // dropping to true black (corners sit around length(glass) ~= 0.74).
        float vignette = max(smoothstep(1.0, 0.16, length(glass)), 0.18);
        float scan = sin(uv.y * resolution.y * 1.72) * 0.5 + 0.5;
        float fineScan = sin(uv.y * resolution.y * 3.35) * 0.5 + 0.5;
        float grain = hash(floor(vec2(uv.x * resolution.x, uv.y * resolution.y)) + 17.0);
        float band = smoothstep(0.0, 0.9, sin(uv.y * 8.5) * 0.5 + 0.5);
        float centerFog = pow(max(0.0, 1.0 - length(glass * vec2(0.9, 0.74))), 2.8);
        float lowFog = pow(max(0.0, 1.0 - distance(uv, vec2(0.42, 0.68)) * 1.72), 2.35);
        float rightFog = pow(max(0.0, 1.0 - distance(uv, vec2(0.68, 0.55)) * 1.92), 2.55);

        vec3 base = baseColor * 0.3;
        vec3 glow = tint * 0.13 * (0.13 + centerFog * 0.46);
        vec3 phosphor = tint * 0.46 * lowFog * 0.075;
        vec3 cyanMist = cold * 0.46 * rightFog * 0.07;
        vec3 archive = vec3(0.38, 0.2, 0.0) * hoverArchive * 0.16;
        vec3 kill9 = vec3(0.0, 0.3, 0.32) * hoverKill9 * 0.18;
        vec3 crossette = vec3(0.23, 0.02, 0.22) * hoverCrossette * 0.13;
        vec3 systems = vec3(0.0, 0.24, 0.12) * hoverSystems * 0.12;

        // Electron-beam halo — a soft phosphor charge that trails the pointer
        // (eased + decayed on the JS side so an idle page has no hot spot).
        vec2 md = (uv - mouse) * vec2(resolution.x / resolution.y, 1.0);
        float beamGlow = exp(-dot(md, md) * 16.0) * beam;

        // Tube hum — two incommensurate sines make a slow non-repeating
        // brightness waver, ~1% amplitude. Felt, not seen.
        float hum = 1.0;

        vec3 color = base + glow + phosphor + cyanMist + archive + kill9 + crossette + systems;
        color += tint * 0.30 * beamGlow * 0.11;
        color *= 0.8 + scan * 0.13 + fineScan * 0.05;
        color += tint * 0.045 * band * 0.01;

        color *= vignette * hum;


        // These broad glows used to be separate, very low-alpha CSS gradients.
        // Compose them in float precision here, then dither the combined fade.
        vec2 screenUv = vec2(uv.x, 1.0 - uv.y);
        vec2 fogUv = (screenUv + 0.2) / 1.4;
        vec2 fogA = (fogUv - vec2(0.38, 0.51)) / vec2(0.23, 0.20);
        vec2 fogB = (fogUv - vec2(0.54, 0.66)) / vec2(0.27, 0.33);
        vec2 fogC = (fogUv - vec2(0.25, 0.70)) / vec2(0.30, 0.29);
        vec3 fog = mix(tint, vec3(0.8), 0.5) * 0.70 * 0.055 * exp(-dot(fogA, fogA) * 2.8);
        fog += cold * 0.43 * 0.075 * exp(-dot(fogB, fogB) * 2.8);
        fog += tint * 0.34 * 0.08 * exp(-dot(fogC, fogC) * 2.8);
        // Match the old screen-blended layer's opacity; CSS still supplies
        // the original scanlines, edge vignette, and foreground text glow.
        color = 1.0 - (1.0 - color) * (1.0 - fog * (0.68 / 0.82));
        float outputGrain = hash(gl_FragCoord.xy + vec2(47.0, 113.0)) - 0.5;
        // Slightly wider coverage breaks up the remaining contour steps after
        // CSS compositing. Clamp near black to retain the same average tone.
        vec3 amplitude = min(vec3(8.0 / 255.0), max(color, 0.0) * 2.0);
        color += outputGrain * amplitude;
        gl_FragColor = vec4(color, 1.0);
    }
