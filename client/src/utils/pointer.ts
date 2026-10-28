/** Convert viewport coordinates to the zoomed interface's layout coordinates. */
export function interfaceScale(): number {
  if (typeof document === 'undefined') return 1;
  return Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
}
export function layoutPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
  const scale = interfaceScale();
  return { x: event.clientX / scale, y: event.clientY / scale };
}

export function layoutRect(rect: { left: number; right: number; top: number; bottom: number; width: number; height: number }) {
  const scale = interfaceScale();
  return { left: rect.left / scale, right: rect.right / scale, top: rect.top / scale, bottom: rect.bottom / scale, width: rect.width / scale, height: rect.height / scale };
}
