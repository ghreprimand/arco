import { memo, useEffect, useRef } from 'react';
import fragment from './ambient.frag.glsl?raw';

export const ambientStats = { frames: 0, running: false, context: 'pending', width: 0, height: 0, cpuMs: 0, maxCpuMs: 0, resources: 0 };
Object.assign(window, { arcoPhosphorStats: ambientStats });

// One low-resolution, opaque pass. CSS owns all glyph emission and raster.
// Idle draws stop entirely; a pointer wakes a bounded 30fps decay, with no sweep.
export const Ambient = memo(function Ambient() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const coarse = matchMedia('(hover: none), (pointer: coarse)');
    let gl: WebGLRenderingContext | null = null;
    let program: WebGLProgram | null = null;
    let buffer: WebGLBuffer | null = null;
    let uniforms: Record<string, WebGLUniformLocation | null> = {};
    let raf = 0, timer = 0, last = 0, moved = -1e6, charge = 0;
    let mx = .5, my = .5, px = .5, py = .5, lost = false, failed = false;
    const allowed = () => !document.hidden && !motion.matches && !coarse.matches && innerWidth > 720 && !lost && !failed;
    function stop() {
      cancelAnimationFrame(raf); clearTimeout(timer); raf = timer = 0; ambientStats.running = false;
    }
    function dispose() {
      if (gl && !lost) { if (program) gl.deleteProgram(program); if (buffer) gl.deleteBuffer(buffer); }
      program = buffer = null; ambientStats.resources = 0;
    }
    function setup() {
      gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
      if (!gl) { failed = true; ambientStats.context = 'fallback'; return; }
      const shaders: WebGLShader[] = [];
      try {
        for (const [type, source] of [[gl.VERTEX_SHADER, 'attribute vec2 aPos; varying vec2 vUv; void main(){vUv=aPos*.5+.5;gl_Position=vec4(aPos,0.,1.);}'], [gl.FRAGMENT_SHADER, fragment]] as const) {
          const shader = gl.createShader(type)!; shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('shader compile failed');
        }
        program = gl.createProgram()!;
        shaders.forEach(shader => gl!.attachShader(program!, shader)); gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('shader link failed');
        gl.useProgram(program); buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const pos = gl.getAttribLocation(program, 'aPos'); gl.enableVertexAttribArray(pos); gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
        uniforms = Object.fromEntries(['resolution', 'mouse', 'beam', 'tint', 'cold', 'baseColor'].map(n => [n, gl!.getUniformLocation(program!, n)]));
        ambientStats.context = 'webgl'; ambientStats.resources = 2;
        resize(); palette();
      } catch { failed = true; ambientStats.context = 'fallback'; dispose(); }
      finally { shaders.forEach(s => gl!.deleteShader(s)); }
    }
    function palette() {
      if (!gl || !program) return;
      const css = getComputedStyle(document.documentElement);
      // Follow Arco's independently shifted background token, including its
      // rgb() serialization. Palette-only aliases miss the background dimmer.
      for (const [name, token] of [['tint', '--arco-emission'], ['cold', '--arco-cold'], ['baseColor', '--color-bg']]) {
        const raw = css.getPropertyValue(token).trim();
        const rgb = raw.startsWith('#') ? [1, 3, 5].map(i => parseInt(raw.slice(i, i + 2), 16)) : (raw.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        if (rgb.length === 3 && rgb.every(Number.isFinite)) gl.uniform3fv(uniforms[name], rgb.map(v => v / 255));
      }
      wake();
    }
    function resize() {
      if (!gl || !program) return;
      const ratio = Math.min(devicePixelRatio || 1, 1.5, 900 / Math.max(innerWidth, innerHeight));
      canvas.width = Math.round(innerWidth * ratio); canvas.height = Math.round(innerHeight * ratio);
      gl.viewport(0, 0, canvas.width, canvas.height); gl.uniform2f(uniforms.resolution, innerWidth, innerHeight);
      ambientStats.width = canvas.width; ambientStats.height = canvas.height;
    }
    function draw(now: number) {
      raf = 0;
      if (!allowed() || !gl || !program) { stop(); return; }
      const start = performance.now(), dt = Math.min(.1, (now - last) / 1000 || .033); last = now;
      px += (mx - px) * Math.min(1, dt * 5.5); py += (my - py) * Math.min(1, dt * 5.5);
      const target = now - moved < 350 ? 1 : 0;
      charge += (target - charge) * Math.min(1, dt * (target ? 5 : 1.4));
      if (!target && charge < .005) charge = 0;
      gl.uniform2f(uniforms.mouse, px, py); gl.uniform1f(uniforms.beam, charge); gl.drawArrays(gl.TRIANGLES, 0, 3);
      const cost = performance.now() - start;
      ambientStats.frames++; ambientStats.cpuMs += cost; ambientStats.maxCpuMs = Math.max(ambientStats.maxCpuMs, cost);
      if (target || charge > 0) timer = window.setTimeout(() => { timer = 0; raf = requestAnimationFrame(draw); }, 34);
      else ambientStats.running = false;
    }
    function wake() { if (allowed() && program && !raf && !timer) { ambientStats.running = true; raf = requestAnimationFrame(draw); } }
    function sync() {
      stop(); canvas.hidden = !allowed();
      if (!allowed()) return;
      if (!program) setup();
      canvas.hidden = !allowed(); if (allowed()) { resize(); wake(); }
    }
    function pointer(e: PointerEvent) { mx = e.clientX / innerWidth; my = 1 - e.clientY / innerHeight; moved = performance.now(); wake(); }
    function onLost(e: Event) { e.preventDefault(); lost = true; stop(); program = buffer = null; ambientStats.resources = 0; ambientStats.context = 'lost'; canvas.hidden = true; }
    function onRestored() { lost = false; failed = false; sync(); }
    window.addEventListener('pointermove', pointer, { passive: true }); window.addEventListener('resize', sync);
    window.addEventListener('arco:theme-changed', palette); document.addEventListener('visibilitychange', sync);
    motion.addEventListener('change', sync); coarse.addEventListener('change', sync);
    canvas.addEventListener('webglcontextlost', onLost); canvas.addEventListener('webglcontextrestored', onRestored);
    sync();
    return () => {
      stop(); dispose();
      window.removeEventListener('pointermove', pointer); window.removeEventListener('resize', sync);
      window.removeEventListener('arco:theme-changed', palette); document.removeEventListener('visibilitychange', sync);
      motion.removeEventListener('change', sync); coarse.removeEventListener('change', sync);
      canvas.removeEventListener('webglcontextlost', onLost); canvas.removeEventListener('webglcontextrestored', onRestored);
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, []);
  return <canvas ref={ref} className="phosphor-ambient" aria-hidden="true" />;
});
