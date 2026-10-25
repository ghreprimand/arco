precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform vec3 uBgColor;

// Midnight Tokyo — rain streaks on a pane of glass. The neon bokeh blobs
// are gone (they read as glowing orbs over chat). Theme identity now lives
// in the streaks themselves and the token palette — the rain is faintly
// tinted toward primary instead of pure white-cool.

float hash(float n) { return fract(sin(n) * 43758.5453); }
vec2 hash2(float n) { return vec2(hash(n), hash(n + 13.13)); }

void main() {
  vec2 frag = vec2(vUv.x, 1.0 - vUv.y) * uResolution;
  vec3 color = vec3(0.0);
  float alpha = 0.0;

  // Rain streaks — vertical elongated drops. Each column has independent
  // speed / length. No glyphs, just translucent slivers that bend the light
  // behind them slightly.
  float cellW = 22.0;
  for (int i = 0; i < 3; i++) {
    float off = float(i) * 0.33;
    float col = floor((frag.x + off * cellW) / cellW);
    if (hash(col * 1.3 + off + 7.1) < 0.35) continue;
    float speed = 320.0 + hash(col + 4.1) * 280.0;
    float len = 60.0 + hash(col + 8.8) * 70.0;
    float wrap = uResolution.y + len + 80.0;
    float headY = mod(uTime * speed + hash(col + 19.3) * wrap, wrap) - len;
    float dy = headY - frag.y;
    if (dy > 0.0 && dy < len) {
      float t = 1.0 - dy / len;
      // Narrow streak — fade toward column edge
      float colCenter = (col + 0.5) * cellW - off * cellW;
      float dx = abs(frag.x - colCenter) / (cellW * 0.35);
      float streak = pow(t, 1.3) * (1.0 - smoothstep(0.0, 1.0, dx));
      // Rain dimmer overall now that the bokeh isn't carrying alpha.
      // Faint primary tint replaces the pure-white-cool look.
      vec3 rainCol = mix(uSecondaryColor, uPrimaryColor, 0.35);
      color += rainCol * streak * 0.32;
      alpha += streak * 0.30;
    }
  }

  // (Vignette removed — radial gradient banded against near-black.)
  gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.9));
}
