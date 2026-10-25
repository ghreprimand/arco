import type { Theme } from '../types';
import { matrix } from '../definitions/matrix';
import { hexToRgb, mix, arcoThemes, readable, resolvePalette } from './arco-palette';

export const PHOSPHOR_PREFIX = 'phosphor:arco:';
export function phosphorTheme(id: string): Theme {
  const originalId = id.startsWith(PHOSPHOR_PREFIX) ? id.slice(PHOSPHOR_PREFIX.length) : id;
  const entry = arcoThemes.find(t => t.id === originalId);
  if (!entry) throw new Error(`Unknown Phosphor palette: ${id}`);
  const p = resolvePalette(entry.id);
  // Archon's broad fills expose more violet than the reference terminal's transparent cards.
  // Keep the purple nearly black so the blue stands out. The muted ink and
  // its glass emission lean slightly bluer and darker than the reference terminal's catalog.
  if (entry.id === 'electric') {
    for (const key of ['--bg-primary', '--bg-input', '--bg-secondary', '--bg-card', '--bg-tertiary', '--bg-card-hover']) {
      p[key] = mix(mix(p[key], '#000000', .6), '#000818', .1);
    }
    const surfaces = [p['--bg-primary'], p['--bg-secondary'], p['--bg-tertiary']];
    p['--text-muted'] = p['--text-secondary'] = readable('#7d83b8', surfaces);
    p['--border-primary'] = '#171a36';
    p['--border-secondary'] = mix(p['--bg-primary'], p['--border-primary'], .65);
    p['--control-border'] = readable(p['--border-primary'], surfaces, 3);
    p['--glass'] = mix(p['--text-muted'], p['--accent'], .22);
    p['--glass-rgb'] = hexToRgb(p['--glass']).join(',');
  }
  const alpha = (color: string, a: number) => `rgba(${hexToRgb(color).join(',')},${a})`;
  const tokens: Record<string, string> = {
    'color-bg': p['--bg-primary'], 'color-bg-panel': p['--bg-secondary'],
    'color-bg-input': p['--bg-input'], 'color-bg-elevated': p['--bg-tertiary'], 'color-bg-sunken': p['--bg-input'], 'color-bg-secondary': p['--bg-secondary'],
    'color-fg': p['--text-primary'], 'color-fg-muted': p['--text-muted'], 'color-fg-secondary': p['--text-primary'],
    'color-text-primary': p['--text-primary'], 'color-bg-base': p['--bg-input'],
    'color-accent-primary': p['--accent'], 'color-accent-primary-dim': p['--accent'],
    'color-accent-primary-tint': p['--bg-tertiary'], 'color-accent-primary-glow': p['--accent-glow'],
    'color-accent-secondary': p['--blue'], 'color-accent-secondary-dim': p['--blue'],
    'color-accent-secondary-bright': p['--blue'], 'color-accent-secondary-glow': p['--blue-bg'],
    'color-border-hairline': p['--border-primary'], 'color-border-bright': p['--control-border'],
    'color-danger': p['--red'], 'color-error': p['--red'], 'color-warning': p['--orange'],
    'color-warning-dim': p['--orange'], 'color-success': p['--green'], 'color-shadow': 'rgba(0,0,0,.8)',
  };
  for (const key of Object.keys(matrix.tokens)) {
    const m = key.match(/^color-accent-(primary|secondary)-a(\d+)$/);
    if (m) tokens[key] = alpha(p[m[1] === 'primary' ? '--accent' : '--blue'], Number(m[2]) / 100);
  }
  // Phosphor role aliases are local to this family; cleaned on family switches.
  for (const [key, value] of Object.entries(p)) tokens[`arco${key.slice(1)}`] = value;
  return {
    id: PHOSPHOR_PREFIX + entry.id, name: entry.name, description: `Arco / ${entry.category}`, family: 'phosphor', category: entry.category, mood: 'dark', tokens,
    fonts: { display: "'Arco Demo Mono', monospace", body: "'Arco Demo Mono', monospace", code: "'Arco Demo Mono', monospace" },
    glyphs: matrix.glyphs,
    density: { ...matrix.density },
    shaderPreset: 'none', borderRenderer: 'css',
    animations: { scan: false, pulseHalo: false, flicker: false, cursorBlink: false },
  };
}
