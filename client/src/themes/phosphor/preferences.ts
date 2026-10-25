import { phosphorEmission } from './emission';

const EFFECTS_KEY = 'archon_phosphor_effects';
const SOFTNESS_KEY = 'archon_phosphor_softness';
export function readPhosphorPreferences(): { phosphorEffects: boolean; phosphorSoftness: number } {
  try {
    const value = localStorage.getItem(SOFTNESS_KEY);
    const n = value === null ? 50 : Number(value);
    return { phosphorEffects: localStorage.getItem(EFFECTS_KEY) !== '0', phosphorSoftness: Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 50 };
  } catch { return { phosphorEffects: true, phosphorSoftness: 50 }; }
}
export function applyPhosphorPreferences(p: { phosphorEffects?: boolean; phosphorSoftness?: number }, cache = false): void {
  const root = document.documentElement;
  const effects = p.phosphorEffects ?? true;
  const softness = p.phosphorSoftness ?? 50;
  root.dataset.phosphorEffects = effects ? 'on' : 'off';
  root.dataset.phosphorSoftness = String(softness);
  if (root.dataset.themeFamily === 'phosphor') root.style.setProperty('--phosphor-text', phosphorEmission(softness));
  if (cache) try {
    localStorage.setItem(EFFECTS_KEY, effects ? '1' : '0');
    localStorage.setItem(SOFTNESS_KEY, String(softness));
  } catch { /* Private storage: settings still persist on the server. */ }
}
