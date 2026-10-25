// Throttled requestAnimationFrame loop with visibility-pause built in.
//
// Two reasons this exists:
//
// 1. **Frame-rate cap.** Decorative shader loops don't benefit from 144Hz —
//    a 60fps cap halves GPU work on high-refresh displays without any
//    perceptible visual difference. Firefox 150 / Wayland on Hyprland
//    appears to drive rAF at the monitor's true refresh, so on a 144Hz
//    panel the uncapped path will happily run shaders at 144fps.
//
// 2. **Visibility pause.** Browsers throttle rAF when the tab is fully
//    hidden, but a tab that's visible-but-not-focused (Arco backgrounded
//    behind another window) still ticks at full speed. We listen for
//    `visibilitychange` and stop calling rAF entirely when hidden.
//
// Returns a stop() that cancels the loop and removes the listener — call
// it from the component's effect cleanup.
export function startThrottledRaf(
  render: () => void,
  options: { targetFps?: number } = {},
): () => void {
  const targetFps = options.targetFps ?? 60;
  // -1ms tolerance so we don't skip a frame when the rAF callback fires
  // ~16.6ms after the last render but the timestamp has 0.5ms jitter.
  const minFrameMs = 1000 / targetFps - 1;

  let raf = 0;
  let last = 0;
  let stopped = false;

  const tick = (now: number) => {
    if (stopped) return;
    if (now - last >= minFrameMs) {
      last = now;
      render();
    }
    raf = requestAnimationFrame(tick);
  };

  const start = () => {
    if (stopped || raf !== 0) return;
    last = 0; // reset so the first frame after resume renders immediately
    raf = requestAnimationFrame(tick);
  };

  const stop = () => {
    if (raf !== 0) cancelAnimationFrame(raf);
    raf = 0;
  };

  const onVisibility = () => {
    if (document.hidden) stop();
    else start();
  };
  document.addEventListener('visibilitychange', onVisibility);

  if (!document.hidden) start();

  return () => {
    stopped = true;
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
