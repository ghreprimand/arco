/** One catalog for server validation, browser controls, charts and exports. */
export interface Theme { id: string; name: string; category: string; bg: string; secondary: string; tertiary?: string; input?: string; border: string; text: string; muted: string; accent: string; accentLight?: string; green?: string; red?: string; orange?: string; blue?: string; purple?: string }
export const PALETTE_VERSION = 1;
export function hexToRgb(hex: string): number[] {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}
export function mix(a: string, b: string, weight: number): string {
  const right = hexToRgb(b);
  return '#' + hexToRgb(a).map((c, i) => Math.round(c + (right[i] - c) * weight).toString(16).padStart(2, '0')).join('');
}
export function luminance(hex: string): number {
  const channels = hexToRgb(hex).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
export function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
/** Keep hue; lift only enough to be readable on every interactive surface. */
export function readable(color: string, surfaces: string[], ratio = 4.5): string {
  for (let i = 0; i <= 100; i++) {
    const candidate = mix(color, '#ffffff', i / 100);
    if (surfaces.every(bg => contrast(candidate, bg) >= ratio)) return candidate;
  }
  return '#ffffff';
}
export function normalizeThemeId(id: unknown): string {
  return arcoThemes.some(t => t.id === id) ? String(id) : 'default';
}
export function resolvePalette(id: unknown): Record<string, string> {
  const t = arcoThemes.find(t => t.id === normalizeThemeId(id))!;
  const tertiary = t.tertiary || mix(t.secondary, '#ffffff', .04);
  const surfaces = [t.bg, t.secondary, tertiary, t.input || t.bg];
  const text = readable(t.text, surfaces), muted = readable(t.muted, surfaces);
  const accent = readable(t.accent, surfaces);
  const colors: Record<string, string> = {
    green: readable(t.green || '#3fb950', surfaces), red: readable(t.red || '#f85149', surfaces),
    orange: readable(t.orange || '#d29922', surfaces), blue: readable(t.blue || '#58a6ff', surfaces),
    purple: readable(t.purple || '#bc8cff', surfaces),
  };
  const alpha = (c: string, a: number) => `rgba(${hexToRgb(c).join(',')},${a})`;
  const result: Record<string, string> = {
    '--bg-primary': t.bg, '--bg-secondary': t.secondary, '--bg-tertiary': tertiary,
    '--bg-card': t.secondary, '--bg-card-hover': tertiary, '--bg-input': t.input || t.bg,
    '--border-primary': t.border, '--border-secondary': mix(t.bg, t.border, .65), '--border-accent': accent,
    '--control-border': readable(t.border, surfaces, 3), '--focus': accent,
    '--text-primary': text, '--text-secondary': muted, '--text-muted': muted, '--text-link': colors.blue,
    '--accent': accent, '--accent-light': readable(t.accentLight || mix(accent, '#ffffff', .25), surfaces),
    '--accent-glow': alpha(accent, .12), '--on-accent': contrast('#000000', accent) >= contrast('#ffffff', accent) ? '#000000' : '#ffffff',
    '--emission': t.accent, '--cold': colors.blue, '--glass': mix(muted, accent, .22),
    '--beam-rgb': hexToRgb(t.accent).join(','), '--glass-rgb': hexToRgb(mix(muted, accent, .22)).join(','),
  };
  for (const [name, color] of Object.entries(colors)) {
    result['--' + name] = color; result['--' + name + '-bg'] = alpha(color, .12);
  }
  ['accent', 'blue', 'green', 'orange', 'purple', 'red'].forEach((name, i) => result['--chart-' + (i + 1)] = result['--' + name]);
  for (let i = 1; i <= 6; i++) result['--chart-' + (i + 6)] = mix(result['--chart-' + i], result['--chart-' + (i % 6 + 1)], .35);
  return result;
}
export const arcoThemes: Theme[] = [
  // --- Default ---
  { id: 'default', name: 'Arco (Default)', category: 'Default',
    bg: '#0d1117', secondary: '#161b22', tertiary: '#1c2128', input: '#0d1117',
    border: '#30363d', text: '#e6edf3', muted: '#8b949e', accent: '#ff8c00',
    accentLight: '#ffd700' },

  { id: 'arco-crt', name: 'Arco CRT', category: 'Terminal', bg: '#020806', secondary: '#07110d', tertiary: '#0c1a14', input: '#020806', border: '#335d43', text: '#cfded4', muted: '#86b8aa', accent: '#00ffaa', accentLight: '#a6ffdc', green: '#63d98e', red: '#ff8a99', orange: '#ffd078', blue: '#71d9eb', purple: '#d4a7ed' },
  // --- Dark ---
  { id: 'midnight', name: 'Midnight', category: 'Dark', bg: '#0a0a0a', secondary: '#141414', tertiary: '#1a1a1a', input: '#111111', border: '#2a2a2a', text: '#e4e4e7', muted: '#b0b8c4', accent: '#2dd4bf' },
  { id: 'ocean', name: 'Ocean', category: 'Dark', bg: '#0c1929', secondary: '#162033', tertiary: '#1a2840', input: '#131d2e', border: '#1e3a5f', text: '#e2e8f0', muted: '#8b9bb5', accent: '#38bdf8' },
  { id: 'nord', name: 'Nord', category: 'Dark', bg: '#2e3440', secondary: '#3b4252', tertiary: '#434c5e', input: '#353b49', border: '#4c566a', text: '#eceff4', muted: '#9aa5b8', accent: '#88c0d0' },
  { id: 'dracula', name: 'Dracula', category: 'Dark', bg: '#282a36', secondary: '#343746', tertiary: '#3a3d50', input: '#2f3240', border: '#44475a', text: '#f8f8f2', muted: '#8892b8', accent: '#bd93f9' },
  { id: 'onedark', name: 'One Dark', category: 'Dark', bg: '#282c34', secondary: '#21252b', tertiary: '#2c313a', input: '#1e2227', border: '#3e4451', text: '#c8cdd6', muted: '#9aa0aa', accent: '#61afef' },
  { id: 'tokyonight', name: 'Tokyo Night', category: 'Dark', bg: '#1a1b26', secondary: '#24283b', tertiary: '#292e42', input: '#1f2335', border: '#3b4261', text: '#c0caf5', muted: '#9aa0c0', accent: '#7aa2f7' },
  { id: 'catppuccin', name: 'Catppuccin Mocha', category: 'Dark', bg: '#1e1e2e', secondary: '#181825', tertiary: '#212130', input: '#1a1a28', border: '#313244', text: '#cdd6f4', muted: '#8e95a8', accent: '#cba6f7' },
  { id: 'gruvbox', name: 'Gruvbox Dark', category: 'Dark', bg: '#282828', secondary: '#1d2021', tertiary: '#252423', input: '#1a1918', border: '#3c3836', text: '#ebdbb2', muted: '#a89984', accent: '#fe8019' },
  { id: 'solarized', name: 'Solarized Dark', category: 'Dark', bg: '#002b36', secondary: '#073642', tertiary: '#0a3e4c', input: '#04303b', border: '#586e75', text: '#e0e8ea', muted: '#a8b8b8', accent: '#2aa198' },
  { id: 'solarized-hc', name: 'Solarized Dark HC', category: 'Dark', bg: '#001e27', secondary: '#002831', tertiary: '#003748', input: '#001e27', border: '#006488', text: '#fcf4dc', muted: '#9cc2c3', accent: '#00b39e', accentLight: '#51ef84' },
  { id: 'rosepine', name: 'Rose Pine', category: 'Dark', bg: '#191724', secondary: '#1f1d2e', tertiary: '#242234', input: '#1c1a29', border: '#26233a', text: '#e0def4', muted: '#908caa', accent: '#c4a7e7' },
  { id: 'horizon', name: 'Horizon', category: 'Dark', bg: '#1C1E26', secondary: '#282b37', tertiary: '#2e3140', input: '#24272f', border: '#3a3e4e', text: '#f8f8f2', muted: '#a8aeb8', accent: '#E95678' },
  { id: 'kanagawa', name: 'Kanagawa Wave', category: 'Dark', bg: '#16161D', secondary: '#223249', tertiary: '#282e42', input: '#1a1e2e', border: '#363d52', text: '#dcd7ba', muted: '#938AA9', accent: '#7aa89f' },
  { id: 'nightowl', name: 'Night Owl', category: 'Dark', bg: '#011627', secondary: '#0b2942', tertiary: '#112e4a', input: '#07203a', border: '#1e4060', text: '#d6deeb', muted: '#a0b5cc', accent: '#82aaff' },
  { id: 'ayu', name: 'Ayu Dark', category: 'Dark', bg: '#0B0E14', secondary: '#131721', tertiary: '#181d28', input: '#0f131b', border: '#565B66', text: '#d8d6d0', muted: '#a0a49e', accent: '#E6B450' },
  { id: 'tokyostorm', name: 'Tokyo Storm', category: 'Dark', bg: '#24283b', secondary: '#1f2335', tertiary: '#292e42', input: '#222638', border: '#414868', text: '#ddd8d2', muted: '#a0a5c0', accent: '#7dcfff' },
  { id: 'everforest', name: 'Everforest', category: 'Dark', bg: '#272e33', secondary: '#2e363b', tertiary: '#343e44', input: '#2b3338', border: '#374145', text: '#d3c6aa', muted: '#9da58e', accent: '#a7c080' },
  { id: 'tomorrownight', name: 'Tomorrow Night', category: 'Dark', bg: '#1d1f21', secondary: '#282a2e', tertiary: '#2e3034', input: '#242628', border: '#373b41', text: '#c5c8c6', muted: '#969896', accent: '#81beb7' },
  { id: 'gruvboxmat', name: 'Gruvbox Material', category: 'Dark', bg: '#282828', secondary: '#32302F', tertiary: '#3a3735', input: '#2e2c2b', border: '#504945', text: '#d4be98', muted: '#a89984', accent: '#d8a657' },

  // --- Terminal ---
  { id: 'matrix', name: 'Matrix', category: 'Terminal', bg: '#0d0208', secondary: '#0d0d0d', border: '#003b00', text: '#00ff41', muted: '#30b830', accent: '#00ff41' },
  { id: 'amber', name: 'Amber CRT', category: 'Terminal', bg: '#0a0800', secondary: '#121008', border: '#2a2000', text: '#ffb000', muted: '#c08820', accent: '#ffb000' },
  { id: 'phosphor', name: 'Phosphor Green', category: 'Terminal', bg: '#001100', secondary: '#001a00', border: '#003300', text: '#33ff33', muted: '#40b040', accent: '#33ff33' },
  { id: 'tango', name: 'Tango', category: 'Terminal', bg: '#2e3436', secondary: '#1c1f20', border: '#555753', text: '#d3d7cf', muted: '#a0a298', accent: '#729fcf' },
  { id: 'red-planet', name: 'Red Planet', category: 'Terminal',
    bg: '#181818', secondary: '#222222', tertiary: '#292929', input: '#202020',
    border: '#676767', text: '#c66a5a', muted: '#a34c49', accent: '#c66a5a',
    accentLight: '#e8bf6a', red: '#c66a5a', green: '#869985', orange: '#e8bf6a',
    blue: '#69819e', purple: '#896492' },
  { id: 'monokai', name: 'Monokai', category: 'Terminal', bg: '#272822', secondary: '#1e1f1c', border: '#49483e', text: '#f8f8f2', muted: '#a0998a', accent: '#a6e22e' },
  { id: 'synthwave', name: 'Synthwave', category: 'Terminal', bg: '#241b2f', secondary: '#2b213a', border: '#38294f', text: '#e0def4', muted: '#9a8ab0', accent: '#ff7edb' },
  { id: 'box', name: 'Box (HackTheBox)', category: 'Terminal', bg: '#141d2b', secondary: '#1a2640', tertiary: '#1e2c48', input: '#172238', border: '#0d73cc', text: '#9fef00', muted: '#9a9a9a', accent: '#9fef00' },
  { id: 'haxor', name: 'HaX0R Green', category: 'Terminal', bg: '#0a1f0a', secondary: '#0e2a0e', tertiary: '#123212', input: '#0c240c', border: '#334843', text: '#15d00d', muted: '#6aaa65', accent: '#19e20e' },
  { id: 'gotham', name: 'Gotham', category: 'Terminal', bg: '#0a3749', secondary: '#0c4258', tertiary: '#0e4c64', input: '#0b3c50', border: '#2a5a6a', text: '#99d1ce', muted: '#7aaba8', accent: '#2aa889' },
  { id: 'dusklight', name: 'Dusklight', category: 'Terminal', bg: '#04142E', secondary: '#052E51', tertiary: '#063660', input: '#042844', border: '#0a4a78', text: '#b0e8ff', muted: '#90b8cc', accent: '#00ADFF' },
  { id: 'phoenix', name: 'Phoenix Night', category: 'Terminal', bg: '#1a1b26', secondary: '#222330', tertiary: '#282938', input: '#1e1f2c', border: '#414868', text: '#ddd8d2', muted: '#a0a5c0', accent: '#7dcfff' },
  { id: 'kyli0x', name: 'Kyli0x', category: 'Terminal', bg: '#222222', secondary: '#2a2a2a', tertiary: '#323232', input: '#262626', border: '#3a3a3a', text: '#e8f6f5', muted: '#5ec4bc', accent: '#21d6c9' },
  { id: 'adapta', name: 'Adapta', category: 'Terminal', bg: '#111818', secondary: '#182020', tertiary: '#1e2828', input: '#141c1c', border: '#2a3838', text: '#dce4e8', muted: '#a0b4ba', accent: '#00bcd4' },
  { id: 'elementarish', name: 'Elementary', category: 'Terminal', bg: '#333333', secondary: '#3c3c3c', tertiary: '#444444', input: '#383838', border: '#555555', text: '#eee8d5', muted: '#9a9688', accent: '#268ad0' },

  // --- Nature ---
  { id: 'forest', name: 'Forest', category: 'Nature', bg: '#0a1a0a', secondary: '#112211', border: '#1a3a1a', text: '#e4e4e7', muted: '#8aaf90', accent: '#4ade80' },
  { id: 'autumn', name: 'Autumn', category: 'Nature', bg: '#1a120a', secondary: '#221810', border: '#3a2a1a', text: '#e8ddd0', muted: '#b8a490', accent: '#d97706' },
  { id: 'arctic', name: 'Arctic', category: 'Nature', bg: '#0f1a2e', secondary: '#162240', border: '#1e3a5f', text: '#e8edf5', muted: '#90a5c0', accent: '#7dd3fc' },
  { id: 'desert', name: 'Desert', category: 'Nature', bg: '#1a1510', secondary: '#221c14', border: '#3a3020', text: '#e8dcc8', muted: '#b8a898', accent: '#e8a44a' },
  { id: 'volcanic', name: 'Volcanic', category: 'Nature', bg: '#1a0a0a', secondary: '#221010', border: '#3a1a1a', text: '#e8d0d0', muted: '#b89090', accent: '#ef4444' },
  { id: 'lavender', name: 'Lavender Fields', category: 'Nature', bg: '#16121e', secondary: '#1c1826', border: '#2e2840', text: '#e4ddf0', muted: '#a098b8', accent: '#a78bfa' },
  { id: 'matcha', name: 'Matcha Sea', category: 'Nature', bg: '#2d2042', secondary: '#342848', tertiary: '#3a2e50', input: '#302446', border: '#4a3868', text: '#F8F8F2', muted: '#a098b0', accent: '#2eb398' },
  { id: 'evergreen', name: 'Evergreen', category: 'Nature', bg: '#1a2418', secondary: '#222e20', tertiary: '#283628', input: '#1e2a1c', border: '#3a4a38', text: '#d3c6aa', muted: '#9aaa90', accent: '#83c092' },

  // --- Retro ---
  { id: 'commodore', name: 'Commodore 64', category: 'Retro', bg: '#40318d', secondary: '#352878', border: '#5a4aaf', text: '#c8c8ff', muted: '#a8a0e0', accent: '#c8c8ff' },
  { id: 'gameboy', name: 'Game Boy', category: 'Retro', bg: '#0f380f', secondary: '#1a4a1a', border: '#306230', text: '#8bac0f', muted: '#709000', accent: '#9bbc0f' },
  { id: 'vaporwave', name: 'Vaporwave', category: 'Retro', bg: '#1a0a2e', secondary: '#220e3a', border: '#3a1a5e', text: '#e0d0f8', muted: '#a890c8', accent: '#ff71ce' },
  { id: 'cyberpunk', name: 'Cyberpunk', category: 'Retro', bg: '#0a0a1a', secondary: '#10102a', border: '#1a1a3a', text: '#e0e0ff', muted: '#9090b8', accent: '#f0e040' },
  { id: 'tron', name: 'Tron', category: 'Retro', bg: '#0c141f', secondary: '#101a28', border: '#162030', text: '#c8e0f0', muted: '#98b0c8', accent: '#6fe8e0' },
  { id: 'hotdog', name: 'Hot Dog Stand', category: 'Retro', bg: '#8b0000', secondary: '#a01010', tertiary: '#b01818', input: '#921010', border: '#cc2222', text: '#ffff00', muted: '#ffcc66', accent: '#ffff00' },
  { id: 'trafficlight', name: 'Traffic Light', category: 'Retro', bg: '#000000', secondary: '#0a0a14', tertiary: '#101020', input: '#060610', border: '#4d4dff', text: '#d1d1e0', muted: '#9999cc', accent: '#9933ff' },

  // --- Neon ---
  { id: 'hotpink', name: 'Hot Pink', category: 'Neon', bg: '#120812', secondary: '#1a0e1a', border: '#2e1a2e', text: '#f0d0f0', muted: '#b888b8', accent: '#ff1493' },
  { id: 'electric', name: 'Electric Blue', category: 'Neon', bg: '#08081a', secondary: '#0e0e2a', border: '#1a1a3e', text: '#d0d0ff', muted: '#8888c8', accent: '#00bfff' },
  { id: 'toxic', name: 'Toxic', category: 'Neon', bg: '#080e08', secondary: '#0e1a0e', border: '#1a2e1a', text: '#d0f0d0', muted: '#80b880', accent: '#39ff14' },
  { id: 'ember', name: 'Ember', category: 'Neon', bg: '#1a0a0a', secondary: '#1f1210', border: '#3a1a1a', text: '#e4e4e7', muted: '#b89888', accent: '#fb923c' },
  { id: 'ultraviolet', name: 'Ultraviolet', category: 'Neon', bg: '#0a0818', secondary: '#120e22', border: '#201a38', text: '#d8d0f0', muted: '#9888c0', accent: '#bf40ff' },
  { id: 'sunset', name: 'Sunset', category: 'Neon', bg: '#1a0e0a', secondary: '#221410', border: '#3a221a', text: '#f0dcd0', muted: '#b89888', accent: '#ff6b6b' },
  { id: 'hotpurple', name: 'Hot Purple', category: 'Neon', bg: '#0e081a', secondary: '#160e26', tertiary: '#1c1430', input: '#120a20', border: '#2a1e42', text: '#e0d0ff', muted: '#a898c0', accent: '#ba1a84' },
  { id: 'cyanglow', name: 'Cyan Glow', category: 'Neon', bg: '#04142E', secondary: '#081e3e', tertiary: '#0a2448', input: '#061a36', border: '#0a3a5e', text: '#99FFFF', muted: '#79A1B4', accent: '#00FFFF' },

  // --- Pastel ---
  { id: 'rose', name: 'Rose', category: 'Pastel', bg: '#1a0a12', secondary: '#1f1018', border: '#3a1a28', text: '#e4e4e7', muted: '#b89098', accent: '#fb7185' },
  { id: 'mint', name: 'Mint', category: 'Pastel', bg: '#0a1a14', secondary: '#10221a', border: '#1a3a2a', text: '#d8f0e8', muted: '#88b8a0', accent: '#6ee7b7' },
  { id: 'peach', name: 'Peach', category: 'Pastel', bg: '#1a1008', secondary: '#22180e', border: '#3a2a18', text: '#f0e0d0', muted: '#b8a890', accent: '#fbbf24' },
  { id: 'sky', name: 'Sky', category: 'Pastel', bg: '#0a1420', secondary: '#101a2a', border: '#1a2a40', text: '#d8e8f8', muted: '#88a0c0', accent: '#7dd3fc' },
  { id: 'lilac', name: 'Lilac', category: 'Pastel', bg: '#14101a', secondary: '#1a1622', border: '#2a2238', text: '#e8e0f0', muted: '#a098b8', accent: '#c4b5fd' },

  // --- Monochrome ---
  { id: 'mono', name: 'Mono', category: 'Monochrome', bg: '#111111', secondary: '#1a1a1a', border: '#333333', text: '#e4e4e7', muted: '#a0a0a0', accent: '#ffffff' },
  { id: 'paper', name: 'Paper', category: 'Monochrome', bg: '#1c1c1c', secondary: '#242424', border: '#3a3a3a', text: '#e0e0e0', muted: '#a8a8a8', accent: '#c0c0c0' },
  { id: 'charcoal', name: 'Charcoal', category: 'Monochrome', bg: '#1a1a1e', secondary: '#222226', border: '#38383e', text: '#dcdce0', muted: '#9898a0', accent: '#b0b0b8' },
  { id: 'ink', name: 'Ink', category: 'Monochrome', bg: '#0e0e12', secondary: '#161618', border: '#2a2a30', text: '#d8d8e0', muted: '#a0a0a8', accent: '#e8e8f0' },
];

export const themeCategories = ['Default', 'Dark', 'Terminal', 'Nature', 'Retro', 'Neon', 'Pastel', 'Monochrome'];
