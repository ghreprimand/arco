import type { CSSProperties } from 'react';

// StatusLight — emissive LED-style indicator. Transposes the DARKN0DE LED
// shader idiom (hard bright core + soft halo + state-keyed breathing period)
// into CSS: a theme-coloured dot wrapped in stacked box-shadow halos and a
// filter: drop-shadow, with animation timing chosen per state.
//
//   nominal  → 3.0s breathe  (calm, alive)
//   warning  → 1.5s breathe  (attention)
//   critical → 0.5s breathe  (urgent)
//   idle     → static        (off-duty)
//
// Colour is sampled from state-bound tokens:
//   nominal  → --color-success
//   warning  → --color-warning
//   critical → --color-danger
//   idle     → --color-fg-muted
//
// The dot's `color` CSS property is set to the state colour so the halo CSS
// (matrix.css → .archon-led + led-breathe-* keyframes) can use currentColor,
// which lets every theme pick up the right glow hue without per-theme rules.
//
// color-mix(in srgb, currentColor N%, transparent) approximates the rgba()
// alpha ramps used elsewhere. Safari/Chrome/Firefox all ship it; this app is
// already on a modern baseline.

export type LEDState = 'nominal' | 'warning' | 'critical' | 'idle';

interface Props {
  state: LEDState;
  label?: string;
  size?: number;
}

const COLOR_VAR: Record<LEDState, string> = {
  nominal: 'var(--color-success)',
  warning: 'var(--color-warning)',
  critical: 'var(--color-danger)',
  idle: 'var(--color-fg-muted)',
};

const ANIM_CLASS: Record<LEDState, string> = {
  nominal: 'led-breathe-nominal',
  warning: 'led-breathe-warning',
  critical: 'led-breathe-critical',
  idle: '',
};

export function StatusLight({ state, label, size = 7 }: Props) {
  const color = COLOR_VAR[state];
  const dotStyle: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    background: color,
    color,
    flexShrink: 0,
    display: 'inline-block',
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className={`archon-led ${ANIM_CLASS[state]}`} style={dotStyle} aria-hidden />
      {label !== undefined && (
        <span
          className="display-font"
          style={{ color, fontSize: 10, letterSpacing: 1, whiteSpace: 'nowrap' }}
        >
          {label}
        </span>
      )}
    </span>
  );
}
