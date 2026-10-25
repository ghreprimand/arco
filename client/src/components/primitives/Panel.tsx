import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ElementType,
  type ForwardedRef,
  type ReactNode,
} from 'react';
import { useAppStore } from '../../stores/appStore';
import { THEME_REGISTRY, DEFAULT_THEME_ID } from '../../themes/registry';

// Themes Phase 7 — `<Panel>` routes panel containers to either a plain CSS
// div/button (every theme shipped before excalidraw) or a Rough.js-rendered
// SVG-bordered surface. Which branch runs is decided by the active theme's
// `borderRenderer` manifest field:
//   - 'css'  → render `El` with merged inline style; existing hairlines stay
//   - 'rough' → render `El` with border/boxShadow stripped, + an absolutely
//     positioned SVG child drawing a wobbly rectangle via roughjs. roughjs
//     is lazy-loaded via dynamic import so the bundle only grows when a
//     rough-rendered theme is actually active. Canvas/SVG re-draws on
//     resize, on theme change, and on active-state change.
//
// API is deliberately narrow (`children / padding / className / style /
// active / as`) because the migration is a mechanical refactor: each panel
// site keeps its own inline layout style and just hands off border rendering
// to Panel. `active` is the busy/glow state — CSS themes apply
// `.glow-border`; rough theme bumps stroke weight + uses the primary accent
// instead of the fg ink color.

type RoughInstance = {
  // Minimal shape of what we use from roughjs' RoughSVG: generator.rectangle
  // returning a Drawable, and `draw(drawable)` returning an SVG group node.
  generator: { rectangle: (x: number, y: number, w: number, h: number, options?: Record<string, unknown>) => unknown };
  draw: (drawable: unknown) => SVGGElement;
};

type RoughModule = {
  default: {
    svg: (svg: SVGSVGElement, config?: Record<string, unknown>) => RoughInstance;
    newSeed: () => number;
  };
};

// Cache the dynamic import so only the first rough panel pays the network/eval
// cost; subsequent mounts (or theme flips back to excalidraw) reuse it.
let roughPromise: Promise<RoughModule> | null = null;
function loadRough(): Promise<RoughModule> {
  if (!roughPromise) {
    // Vite will code-split this import into its own chunk.
    roughPromise = import('roughjs') as Promise<RoughModule>;
  }
  return roughPromise;
}

// Per-panel random seed so each surface has its own wobble signature that
// survives re-draws. Fresh seed per component instance.
function makeSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

export interface PanelProps {
  children?: ReactNode;
  padding?: string | number;
  className?: string;
  style?: CSSProperties;
  /**
   * Busy / focus state — CSS themes apply the `.glow-border` class; rough
   * themes draw a thicker rough stroke in the primary accent color. Maps to
   * the pre-existing per-site pattern where the outer container flipped
   * between `var(--color-border-hairline)` and `var(--color-accent-primary)`.
   */
  active?: boolean;
  /**
   * Polymorphic element type. WorkerCard passes `'button'`; most panel sites
   * keep the default `'div'`. Any additional native props (onClick, title,
   * ARIA) are passed through via the catch-all below.
   */
  as?: 'div' | 'button';
}

type NativeProps = Omit<
  React.HTMLAttributes<HTMLElement> & React.ButtonHTMLAttributes<HTMLButtonElement>,
  keyof PanelProps | 'ref'
>;

export const Panel = forwardRef<HTMLElement, PanelProps & NativeProps>(function Panel(
  { children, padding, className, style, active, as = 'div', ...rest },
  ref,
) {
  // Subscribe to the active theme. Panel re-renders on every theme swap so
  // the branch (css ↔ rough) flips without remounting the hosting site.
  const themeId = useAppStore((s) => s.settings?.themeId ?? DEFAULT_THEME_ID);
  const theme = THEME_REGISTRY[themeId] ?? THEME_REGISTRY[DEFAULT_THEME_ID];
  const isRough = theme.borderRenderer === 'rough';

  const mergedClass = useMemo(() => {
    const parts = ['arco-panel'];
    if (className) parts.push(className);
    // CSS themes opt into the glow-border utility when active; rough themes
    // carry the active read via stroke weight instead.
    if (active && !isRough) parts.push('glow-border');
    return parts.join(' ');
  }, [className, active, isRough]);

  if (!isRough) {
    const El = as as ElementType;
    return (
      <El
        ref={ref as ForwardedRef<HTMLElement>}
        className={mergedClass}
        style={{ ...(padding !== undefined ? { padding } : null), ...style }}
        {...rest}
      >
        {children}
      </El>
    );
  }

  return (
    <RoughPanel
      as={as}
      ref={ref}
      className={mergedClass}
      padding={padding}
      style={style}
      active={!!active}
      strokeWidth={parseFloat(theme.density.borderWidth) || 2}
      {...rest}
    >
      {children}
    </RoughPanel>
  );
});

interface RoughPanelProps extends PanelProps {
  strokeWidth: number;
}

const RoughPanel = forwardRef<HTMLElement, RoughPanelProps & NativeProps>(function RoughPanel(
  { children, padding, className, style, active, as = 'div', strokeWidth, ...rest },
  ref,
) {
  const containerRef = useRef<HTMLElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const roughRef = useRef<RoughInstance | null>(null);
  const drawnRef = useRef<SVGGElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // Stable per-instance seed — keeps the wobble shape identical across
  // redraws/resizes so the panel doesn't "shiver" on every repaint.
  const seedRef = useRef<number>(makeSeed());
  // Track theme swaps that preserve borderRenderer === 'rough' so accent
  // color changes (e.g. another future rough theme) trigger a re-stroke.
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    const onTheme = () => setThemeTick((t) => t + 1);
    window.addEventListener('arco:theme-changed', onTheme);
    return () => window.removeEventListener('arco:theme-changed', onTheme);
  }, []);

  // Observe container size — we redraw whenever the box changes so the rough
  // rectangle matches the rendered panel bounds. ResizeObserver batches so
  // rapid reflows don't thrash.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      // Round to integer pixels — sub-pixel fractional box sizes fed to
      // roughjs create visible jitter on repaint for no visual gain.
      const w = Math.round(box.width + (parseFloat(String(el.style.paddingLeft || 0)) || 0) + (parseFloat(String(el.style.paddingRight || 0)) || 0));
      const h = Math.round(box.height + (parseFloat(String(el.style.paddingTop || 0)) || 0) + (parseFloat(String(el.style.paddingBottom || 0)) || 0));
      // We measure the border-box via offsetWidth/Height instead — contentRect
      // excludes padding and the drawn rectangle needs full panel bounds.
      setSize({ w: el.offsetWidth, h: el.offsetHeight });
    });
    ro.observe(el);
    setSize({ w: el.offsetWidth, h: el.offsetHeight });
    return () => ro.disconnect();
  }, []);

  // Draw / redraw the rough rectangle whenever size, active, stroke, or
  // theme changes. roughjs is imported lazily; first draw blocks on the
  // dynamic chunk load (small — ~10KB gzipped).
  useEffect(() => {
    if (!size || size.w <= 0 || size.h <= 0) return;
    const svg = svgRef.current;
    if (!svg) return;
    let cancelled = false;

    loadRough().then((mod) => {
      if (cancelled) return;
      if (!roughRef.current) {
        roughRef.current = mod.default.svg(svg, { options: { seed: seedRef.current } });
      }
      const rc = roughRef.current;

      // Read ink + primary accent from computed CSS so the stroke follows the
      // live theme tokens without a manifest lookup.
      const root = document.documentElement;
      const cs = getComputedStyle(root);
      const ink = cs.getPropertyValue('--color-fg').trim() || '#1e1e1e';
      const accent = cs.getPropertyValue('--color-accent-primary').trim() || ink;
      const stroke = active ? accent : ink;

      // Inset by half a stroke so the drawn edge sits inside the border box —
      // otherwise the wobble extends past the panel and clips against siblings.
      const inset = Math.max(strokeWidth, 1) + 2;
      const w = Math.max(size.w - inset * 2, 1);
      const h = Math.max(size.h - inset * 2, 1);

      const rect = rc.generator.rectangle(inset, inset, w, h, {
        stroke,
        strokeWidth: active ? strokeWidth + 1 : strokeWidth,
        roughness: 1.2,
        bowing: 1.5,
        seed: seedRef.current,
      });
      const nextNode = rc.draw(rect);
      if (drawnRef.current && drawnRef.current.parentNode === svg) {
        svg.removeChild(drawnRef.current);
      }
      drawnRef.current = nextNode;
    });
    return () => {
      cancelled = true;
    };
  }, [size, active, strokeWidth, themeTick]);

  // Dispose on unmount — svg is destroyed with the React tree, but clear the
  // roughjs instance reference so a remount rebuilds against the new element.
  useEffect(() => {
    return () => {
      roughRef.current = null;
      drawnRef.current = null;
    };
  }, []);

  const El = as as ElementType;
  // Strip border + boxShadow from the caller's style — rough SVG replaces
  // them. Radius stays (the rough rectangle is un-rounded, but the
  // underlying bg / hover states still read as rounded if the caller asks
  // for it). Background and padding flow through.
  const cleanStyle: CSSProperties = useMemo(() => {
    const next: CSSProperties = { ...style };
    delete next.border;
    delete next.borderTop;
    delete next.borderRight;
    delete next.borderBottom;
    delete next.borderLeft;
    delete next.borderColor;
    delete next.borderWidth;
    delete next.borderStyle;
    delete next.boxShadow;
    return next;
  }, [style]);

  const composedRef = (node: HTMLElement | null) => {
    containerRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) (ref as React.MutableRefObject<HTMLElement | null>).current = node;
  };

  return (
    <El
      ref={composedRef}
      className={className}
      style={{
        position: 'relative',
        ...(padding !== undefined ? { padding } : null),
        ...cleanStyle,
        border: 'none',
        boxShadow: 'none',
      }}
      {...rest}
    >
      <svg
        ref={svgRef}
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          overflow: 'visible',
        }}
      />
      {children}
    </El>
  );
});
