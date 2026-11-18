// A snapshot of the Arco theme as it is applied on this page, sent with a
// new phone upload code so the phone page can look the same. Colours and
// sizes are read back from the browser in one plain form; the server checks
// every value again and drops anything else.
const COLORS = [
  'color-bg', 'color-bg-dialog', 'color-fg', 'color-fg-muted', 'color-border',
  'color-accent-primary', 'color-control-fg', 'color-success', 'color-error',
];

export function phoneThemeSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const root = getComputedStyle(document.documentElement);
  const probe = document.createElement('span');
  probe.style.display = 'none';
  probe.style.borderStyle = 'solid';
  document.body.append(probe);
  try {
    for (const key of COLORS) {
      probe.style.color = `var(--${key})`;
      const value = getComputedStyle(probe).color;
      if (/^rgba?\(/.test(value)) snapshot[key] = value;
    }
    probe.style.borderTopWidth = 'var(--border-width)';
    probe.style.borderTopLeftRadius = 'var(--radius-sm)';
    const probed = getComputedStyle(probe);
    snapshot['border-width'] = probed.borderTopWidth;
    snapshot['radius-sm'] = probed.borderTopLeftRadius;
  } finally {
    probe.remove();
  }
  for (const key of ['font-display', 'font-body']) {
    const value = root.getPropertyValue('--' + key).trim();
    if (value) snapshot[key] = value;
  }
  const bg = /^rgba?\((\d+), (\d+), (\d+)/.exec(snapshot['color-bg'] ?? '');
  if (bg) snapshot.scheme = (0.2126 * +bg[1] + 0.7152 * +bg[2] + 0.0722 * +bg[3]) / 255 < 0.5 ? 'dark' : 'light';
  return snapshot;
}
