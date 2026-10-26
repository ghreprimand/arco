// Theme-swap scramble transition — DARKN0DE-inspired reveal animation.
// When the operator switches themes, all visible display-font text runs
// through ~400ms of random glyphs that decode left→right into the new
// theme's final rendering. It's the "Hollywood hacker" effect, but
// only fires on theme *change* so it can't become annoying during
// normal use.
//
// Safety rules:
//  - Skip elements inside interactive inputs — scrambling a focused
//    <input> would detonate the React controlled-input invariant.
//  - Skip long text (> 40 chars): too much visual noise.
//  - If an element's text changes mid-scramble (React re-rendered), we
//    simply abandon that element — no writeback wins against React.
//  - The very first applyTheme call on session start does NOT scramble,
//    so page load isn't a 400ms blur.

const GLYPHS = '01アウカシセタネハミモラワ<>{}|/=+*#$%&?!:;';
const DURATION_MS = 420;
const MAX_LEN = 40;

// Selectors that should scramble. Intersected with textNode-containing
// descendants. Only top-level text of these elements is touched; we do
// NOT recurse past elements that contain child Element nodes, because
// doing so would invalidate element layout on each tick.
const TARGET_SELECTOR = [
  '.display-font',
  '.glow-text',
  '.glow-text-bright',
  '.glow-text-cyan',
  'h1', 'h2', 'h3',
].join(', ');

interface Task {
  node: Text;
  original: string;
  // What this scramble last wrote. Anything else in the node means React
  // changed the text mid-scramble; the task then stops without writing.
  written: string;
  startedAt: number;
}

function randomGlyph(): string {
  return GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
}

function isInsideInput(el: Element): boolean {
  let cur: Element | null = el;
  while (cur) {
    const tag = cur.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
    if ((cur as HTMLElement).isContentEditable) return true;
    cur = cur.parentElement;
  }
  return false;
}

function collectTextNodes(el: Element): Text[] {
  const out: Text[] = [];
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = child as Text;
      const s = t.data.trim();
      if (s.length > 0 && s.length <= MAX_LEN) out.push(t);
    }
  }
  return out;
}

export function installThemeScramble(): () => void {
  // Gate the very first applyTheme event — it fires on app mount from
  // the initial settings load, and we don't want a scramble on load.
  let skippedFirst = false;
  let activeTasks: Task[] = [];
  let raf = 0;

  const onThemeChanged = () => {
    if (!skippedFirst) {
      skippedFirst = true;
      return;
    }

    // Cancel any in-flight scramble — snap those back to their
    // originals so we don't strand half-scrambled text if themes are
    // flipped rapidly.
    for (const t of activeTasks) {
      if (t.node.isConnected && t.node.data === t.written) t.node.data = t.original;
    }
    activeTasks = [];

    // Phosphor palette/brightness changes are paint-only. The Classic reveal
    // rewrites live labels and must not run over this always-open CRT family.
    if (document.documentElement.dataset.themeFamily === 'phosphor') {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      return;
    }

    const targets = document.querySelectorAll(TARGET_SELECTOR);
    const now = performance.now();
    for (const el of Array.from(targets)) {
      if (isInsideInput(el)) continue;
      for (const node of collectTextNodes(el)) {
        activeTasks.push({ node, original: node.data, written: node.data, startedAt: now });
      }
    }

    if (activeTasks.length === 0) return;
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  };

  const tick = () => {
    const now = performance.now();
    const next: Task[] = [];
    for (const t of activeTasks) {
      // Lost the node (React unmount) or React re-rendered the parent
      // and replaced our node. Either way, abandon.
      if (!t.node.isConnected || t.node.data !== t.written) continue;

      const elapsed = now - t.startedAt;
      const progress = Math.min(elapsed / DURATION_MS, 1);
      const len = t.original.length;
      // Characters resolve left-to-right. `revealCount` is how many
      // chars of the original are already locked in. The rest are
      // randomized each frame.
      const revealCount = Math.floor(progress * len);

      if (progress >= 1) {
        t.node.data = t.original;
        continue;
      }

      let out = t.original.slice(0, revealCount);
      for (let i = revealCount; i < len; i++) {
        // Preserve whitespace — scrambling spaces visually smears
        // words together in an ugly way.
        const orig = t.original[i];
        out += orig === ' ' || orig === '\n' || orig === '\t' ? orig : randomGlyph();
      }

      // Only write if different; unnecessary writes trigger layout on
      // elements that inherit from this text node.
      if (t.node.data !== out) t.node.data = out;
      t.written = out;
      next.push(t);
    }
    activeTasks = next;
    if (activeTasks.length > 0) {
      raf = requestAnimationFrame(tick);
    } else {
      raf = 0;
    }
  };

  window.addEventListener('arco:theme-changed', onThemeChanged);
  return () => {
    window.removeEventListener('arco:theme-changed', onThemeChanged);
    if (raf) cancelAnimationFrame(raf);
    // Restore any in-flight tasks on cleanup.
    for (const t of activeTasks) {
      if (t.node.isConnected && t.node.data === t.written) t.node.data = t.original;
    }
    activeTasks = [];
  };
}
