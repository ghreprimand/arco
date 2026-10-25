import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useAppStore } from '../stores/appStore';
import { startThrottledRaf } from '../utils/rafThrottle';

// Presets whose content is discrete/noisy enough — or slow enough — that
// 24fps reads identically to 30fps. Originally just discrete-content
// presets (glyphs/scanlines/grain), expanded to include slow atmospheric
// gradients (aurora, nebula, sentinel, cicada) after testing showed the
// motion is gentle enough that the 30→24 transition is imperceptible.
// Truly fast-motion smooth gradients (liquid-glass, watercolor) stay at
// 30. The fps gap (24 vs 30) is a 20% reduction in shader+compositor
// cost on the matched presets.
const LOW_FPS_PRESETS: Set<ShaderPreset> = new Set([
  'matrix-rain',
  'amber-crt',
  'blueprint-grid',
  'film-grain',
  'star-drift',
  'aurora',
  'nebula',
  'sentinel',
  'cicada',
  'sakura-petals',
]);
function fpsForPreset(p: ShaderPreset): number {
  return LOW_FPS_PRESETS.has(p) ? 24 : 30;
}

// Per-preset canvas opacity. The default 0.32 keeps the gentle gradient
// presets (aurora/nebula/liquid-glass) as a faint wash so they never fight
// the chat text. Matrix-rain is discrete green-on-black with most of the
// frame empty — at 0.32 the cascade barely reads against a dense, bright
// workflow screen (and is further washed out by the operator's bgBrightness
// lift greying the black behind it). It carries a higher opacity so the
// falling glyphs actually punch through. Tune here, not in the shader.
const PRESET_OPACITY: Partial<Record<ShaderPreset, number>> = {
  'matrix-rain': 0.6,
};
function opacityForPreset(p: ShaderPreset): number {
  return PRESET_OPACITY[p] ?? 0.32;
}
import { THEME_REGISTRY, DEFAULT_THEME_ID } from '../themes/registry';
import { readCachedThemeId } from '../themes/bootstrap';
import type { ShaderPreset, Theme } from '../themes/types';
import { hexToVec3 } from '../themes/shaders/util';
import matrixRainFrag from '../themes/shaders/matrixRain.frag.glsl?raw';
import amberCRTFrag from '../themes/shaders/amberCRT.frag.glsl?raw';
import blueprintGridFrag from '../themes/shaders/blueprintGrid.frag.glsl?raw';
import penAndInkFrag from '../themes/shaders/penAndInk.frag.glsl?raw';
import watercolorFrag from '../themes/shaders/watercolor.frag.glsl?raw';
import liquidGlassFrag from '../themes/shaders/liquidGlass.frag.glsl?raw';
import marineSnowFrag from '../themes/shaders/marineSnow.frag.glsl?raw';
import starDriftFrag from '../themes/shaders/starDrift.frag.glsl?raw';
import filmGrainFrag from '../themes/shaders/filmGrain.frag.glsl?raw';
import rainGlassFrag from '../themes/shaders/rainGlass.frag.glsl?raw';
import heatHazeFrag from '../themes/shaders/heatHaze.frag.glsl?raw';
import oscilloscopeFrag from '../themes/shaders/oscilloscope.frag.glsl?raw';
import concreteFrag from '../themes/shaders/concrete.frag.glsl?raw';
import tapeDriftFrag from '../themes/shaders/tapeDrift.frag.glsl?raw';
import bloodmoonFrag from '../themes/shaders/bloodmoon.frag.glsl?raw';
import carbonWeaveFrag from '../themes/shaders/carbonWeave.frag.glsl?raw';
import dskyBloomFrag from '../themes/shaders/dskyBloom.frag.glsl?raw';
import sentinelFrag from '../themes/shaders/sentinel.frag.glsl?raw';
import cherenkovFrag from '../themes/shaders/cherenkov.frag.glsl?raw';
import infraredFrag from '../themes/shaders/infrared.frag.glsl?raw';
import auroraFrag from '../themes/shaders/aurora.frag.glsl?raw';
import nebulaFrag from '../themes/shaders/nebula.frag.glsl?raw';
import sonarFrag from '../themes/shaders/sonar.frag.glsl?raw';
import seismographFrag from '../themes/shaders/seismograph.frag.glsl?raw';
import kintsugiFrag from '../themes/shaders/kintsugi.frag.glsl?raw';
import cicadaFrag from '../themes/shaders/cicada.frag.glsl?raw';
import tarkovskyFrag from '../themes/shaders/tarkovsky.frag.glsl?raw';
import nightCityFrag from '../themes/shaders/nightCity.frag.glsl?raw';
import sakuraPetalsFrag from '../themes/shaders/sakuraPetals.frag.glsl?raw';

// Themes Phase 3 — fullscreen background shader that multiplexes fragment
// programs by the active theme's `shaderPreset`. Replaces the Phase 2
// MatrixRain component (which owned only the matrix-rain effect and gated
// its WebGL context on the preset).
//
// Lifecycle:
//  - Mounts once while any canvas-bearing preset is active. `shaderPreset:
//    'none'` short-circuits before the effect and returns null — the canvas
//    is never created. Switching to/from 'none' remounts the effect.
//  - Canvas-bearing presets ('matrix-rain', 'amber-crt', …) share a single
//    WebGL context. Compiled ShaderMaterials are cached in a
//    `Map<ShaderPreset, ShaderMaterial>` so a back-and-forth swap is
//    instant after the first compile (100–300ms budget per new preset).
//  - `arco:theme-changed` fires from `applyTheme` (themes/apply.ts) with
//    the full Theme in event.detail. On receipt: select/compile the
//    matching material, refresh its color uniforms from the new palette,
//    and swap it onto the mesh.
//  - `uTime` is driven from a single `start` timestamp captured at mount,
//    so matrix-rain ↔ amber-crt swaps don't snap the animation clock.
//
// Matrix-rain carries bespoke uniforms (`uAtlas`, `uGlyphCount`, `uCellPx`);
// the atlas texture is built once per mount and only wired into the
// matrix-rain material. Other presets see only the common
// `uResolution / uTime / uPrimaryColor / uSecondaryColor / uBgColor` set.

const CHARS = '01アウカシセタネハミモラワ<>{}|/=+*';
const GLYPH_PX = 32;
const CELL_PX = 18;

function buildAtlas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = GLYPH_PX * CHARS.length;
  c.height = GLYPH_PX;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#fff';
  ctx.font = `${Math.floor(GLYPH_PX * 0.85)}px monospace`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (let i = 0; i < CHARS.length; i++) {
    ctx.fillText(CHARS[i], i * GLYPH_PX + GLYPH_PX / 2, GLYPH_PX / 2);
  }
  return c;
}

const VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

// Explicit preset → fragment source map. Presets not listed here (currently
// 'none' + Phase 4+ presets) fall back to the null branch in `selectMaterial`.
// 'none' is intentionally absent: the component unmounts its canvas when
// preset === 'none', so compiling a discard-only shader would be dead code.
const FRAGMENT_FOR_PRESET: Partial<Record<ShaderPreset, string>> = {
  'matrix-rain': matrixRainFrag,
  'amber-crt': amberCRTFrag,
  'blueprint-grid': blueprintGridFrag,
  'pen-and-ink': penAndInkFrag,
  watercolor: watercolorFrag,
  'liquid-glass': liquidGlassFrag,
  'marine-snow': marineSnowFrag,
  'star-drift': starDriftFrag,
  'film-grain': filmGrainFrag,
  'rain-glass': rainGlassFrag,
  'heat-haze': heatHazeFrag,
  oscilloscope: oscilloscopeFrag,
  concrete: concreteFrag,
  'tape-drift': tapeDriftFrag,
  bloodmoon: bloodmoonFrag,
  'carbon-weave': carbonWeaveFrag,
  'dsky-bloom': dskyBloomFrag,
  sentinel: sentinelFrag,
  cherenkov: cherenkovFrag,
  infrared: infraredFrag,
  aurora: auroraFrag,
  nebula: nebulaFrag,
  sonar: sonarFrag,
  seismograph: seismographFrag,
  kintsugi: kintsugiFrag,
  cicada: cicadaFrag,
  tarkovsky: tarkovskyFrag,
  'night-city': nightCityFrag,
  'sakura-petals': sakuraPetalsFrag,
};

function cssColorVec3(theme: Theme, key: string, fallback: [number, number, number]): [number, number, number] {
  const raw = theme.tokens[key];
  if (!raw) return fallback;
  try {
    return hexToVec3(raw);
  } catch {
    // Non-hex token (rgba etc.) — shouldn't happen for color-accent-*/color-bg
    // in any manifest today, but if it does, fail soft rather than black-screen.
    return fallback;
  }
}

// Default-exported as well as named so `React.lazy(() => import(...))` in the
// gate module (ThemedBackgroundShader.tsx) can consume it directly. This module
// is the ONLY entry point to three.js + the 29 `?raw` GLSL imports, which is
// what keeps them out of the main chunk — don't import it statically from
// anywhere, or the code-split collapses and the payload lands in index.js again.
export default function ThemedBackgroundShader() {
  // Fall back to the cached themeId (same source bootstrapCachedTheme uses
  // to paint :root before React mounts) when settings haven't resolved yet.
  // Without this fallback the shader builds DEFAULT_THEME_ID's preset
  // (matrix-rain) while CSS vars already reflect the operator's real theme,
  // producing a few hundred ms of matrix rain bleeding through other themes
  // on every reload.
  const themeId = useAppStore((s) => s.settings?.themeId ?? readCachedThemeId() ?? DEFAULT_THEME_ID);
  const theme: Theme = THEME_REGISTRY[themeId] ?? THEME_REGISTRY[DEFAULT_THEME_ID];
  const preset = theme.shaderPreset;
  const needsCanvas = preset !== 'none';

  const containerRef = useRef<HTMLDivElement>(null);
  // Mirror of the current theme for the event handler — refs survive across
  // renders so the handler always sees the latest value without retriggering
  // the effect.
  const themeRef = useRef<Theme>(theme);
  themeRef.current = theme;

  useEffect(() => {
    if (!needsCanvas) return;
    const container = containerRef.current;
    if (!container) return;

    // alpha:false renders to an opaque RGB framebuffer (no alpha channel).
    // On Firefox/Wayland/NVIDIA the alpha-channel canvas forces a per-pixel
    // alpha-blend compositor pass against whatever's beneath the page —
    // that's the path that makes WebRender's compositor cost dominant.
    // An opaque canvas can use the direct-scanout path on supported
    // compositors. Visually identical because the body bg matches the
    // shader clear color (both come from --color-bg), and the CSS
    // opacity:0.32 still applies for the rain dimming.
    const renderer = new THREE.WebGLRenderer({ alpha: false, antialias: false });
    // Pixel ratio capped at 1.0. History: 1.5 → 1.0 (Apr 28 GPU triage)
    // → 0.6 (post-CSS-cuts triage) → 1.0 (Apr 28 clarity-restore). 0.6×
    // bilinear-upscaled glyphs in matrix-rain looked obviously soft because
    // the shader samples a glyph atlas — sub-pixel texel offsets blur the
    // strokes. Other presets are noise/blur fields where DPR is invisible,
    // but the cost has to satisfy the worst case. Compensated for by the
    // 30fps throttle below.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.0));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';

    const scene = new THREE.Scene();
    const camera = new THREE.Camera();
    const geometry = new THREE.PlaneGeometry(2, 2);

    const atlasTex = new THREE.CanvasTexture(buildAtlas());
    atlasTex.minFilter = THREE.LinearFilter;
    atlasTex.magFilter = THREE.LinearFilter;
    atlasTex.wrapS = THREE.ClampToEdgeWrapping;
    atlasTex.wrapT = THREE.ClampToEdgeWrapping;

    const resolution = new THREE.Vector2(1, 1);
    const uTimeRef = { value: 0 };
    // Shared tension uniform ref — a single object reused across all
    // ShaderMaterials. Updating `uTensionRef.value` propagates to every
    // material bound to it without needing per-material iteration.
    // Populated by the `arco:tension` event listener installed below.
    const uTensionRef = { value: 0 };

    const materials = new Map<ShaderPreset, THREE.ShaderMaterial>();

    const buildMaterial = (p: ShaderPreset, t: Theme): THREE.ShaderMaterial | null => {
      const frag = FRAGMENT_FOR_PRESET[p];
      if (!frag) return null;
      const primary = cssColorVec3(t, 'color-accent-primary', [0.29, 0.94, 0.4]);
      const secondary = cssColorVec3(t, 'color-accent-secondary', [0.36, 0.88, 0.84]);
      const bg = cssColorVec3(t, 'color-bg', [0.047, 0.055, 0.063]);
      const uniforms: Record<string, { value: unknown }> = {
        uResolution: { value: resolution },
        uTime: uTimeRef,
        uTension: uTensionRef,
        uPrimaryColor: { value: new THREE.Vector3(...primary) },
        uSecondaryColor: { value: new THREE.Vector3(...secondary) },
        uBgColor: { value: new THREE.Vector3(...bg) },
      };
      if (p === 'matrix-rain') {
        uniforms.uAtlas = { value: atlasTex };
        uniforms.uGlyphCount = { value: CHARS.length };
        uniforms.uCellPx = { value: CELL_PX };
      }
      return new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: frag,
        uniforms,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      });
    };

    const refreshColors = (material: THREE.ShaderMaterial, t: Theme) => {
      const primary = cssColorVec3(t, 'color-accent-primary', [0.29, 0.94, 0.4]);
      const secondary = cssColorVec3(t, 'color-accent-secondary', [0.36, 0.88, 0.84]);
      const bg = cssColorVec3(t, 'color-bg', [0.047, 0.055, 0.063]);
      (material.uniforms.uPrimaryColor.value as THREE.Vector3).set(...primary);
      (material.uniforms.uSecondaryColor.value as THREE.Vector3).set(...secondary);
      (material.uniforms.uBgColor.value as THREE.Vector3).set(...bg);
    };

    const selectMaterial = (t: Theme): THREE.ShaderMaterial | null => {
      const p = t.shaderPreset;
      if (p === 'none') return null;
      let m = materials.get(p);
      if (!m) {
        const built = buildMaterial(p, t);
        if (!built) return null;
        materials.set(p, built);
        m = built;
      } else {
        refreshColors(m, t);
      }
      return m;
    };

    const initialMaterial = selectMaterial(themeRef.current);
    // If the initial preset has no fragment source registered, fall through
    // to a plain transparent material — prevents undefined-material crashes
    // while still rendering the rest of the UI normally.
    const fallbackMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
    const mesh = new THREE.Mesh(geometry, initialMaterial ?? fallbackMaterial);
    scene.add(mesh);

    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      renderer.setSize(w, h, false);
      resolution.set(w, h);
    };
    resize();
    window.addEventListener('resize', resize);

    const onThemeChange = (ev: Event) => {
      const detail = (ev as CustomEvent<Theme>).detail;
      if (!detail) return;
      if (detail.shaderPreset === 'none') {
        // React will unmount this effect on the next render because
        // `needsCanvas` drops to false — no extra work here.
        return;
      }
      const next = selectMaterial(detail);
      if (next) {
        mesh.material = next;
        // Switching presets may change the target fps (LOW_FPS_PRESETS).
        // Restart the rAF so the new throttle takes effect immediately
        // rather than waiting for a remount.
        stopRaf();
        stopRaf = startRaf(fpsForPreset(detail.shaderPreset));
      }
    };
    window.addEventListener('arco:theme-changed', onThemeChange);

    // Tension is driven from useTension.ts which fires arco:tension once
    // per RAF frame. We just mutate the shared uniform's .value — no
    // per-material iteration needed since every ShaderMaterial reuses
    // uTensionRef.
    const onTension = (ev: Event) => {
      const v = (ev as CustomEvent<number>).detail;
      if (typeof v === 'number') uTensionRef.value = v;
    };
    window.addEventListener('arco:tension', onTension);

    const start = performance.now();
    // Per-preset fps cap. Discrete/noisy presets (LOW_FPS_PRESETS) drop to
    // 24fps — falling glyphs and grain read identically at 24 vs 30 because
    // the content is cell-quantized and the eye can't track stutter on
    // it. Smooth-gradient presets stay at 30 because continuous motion
    // shows judder below that. The Wayland-compositor surface-upload cost
    // is per-frame on Firefox/NVIDIA (Mozilla bug 1750457), so the fps cap
    // is the dominant lever — halving frames cuts compositor work in half.
    const startRaf = (fps: number) =>
      startThrottledRaf(() => {
        uTimeRef.value = (performance.now() - start) / 1000;
        renderer.render(scene, camera);
      }, { targetFps: fps });
    let stopRaf = startRaf(fpsForPreset(themeRef.current.shaderPreset));

    return () => {
      stopRaf();
      window.removeEventListener('resize', resize);
      window.removeEventListener('arco:theme-changed', onThemeChange);
      window.removeEventListener('arco:tension', onTension);
      for (const m of materials.values()) m.dispose();
      fallbackMaterial.dispose();
      geometry.dispose();
      atlasTex.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [needsCanvas]);

  if (!needsCanvas) return null;

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        opacity: opacityForPreset(preset),
        pointerEvents: 'none',
      }}
    />
  );
}
