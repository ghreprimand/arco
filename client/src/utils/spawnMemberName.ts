import { presetForText } from '@arco/shared';

/** Default name for a spawned cluster member: the role label (or "Worker") plus the next free number. Never the source's name. */
export function nextMemberName(role: string, existingNames: string[]): string {
  const preset = presetForText(role);
  const custom = role.trim().split(/\s+/).slice(0, 3).join(' ').slice(0, 24);
  const base = preset ? preset.label.charAt(0) + preset.label.slice(1).toLowerCase() : custom || 'Worker';
  const used = new Set<number>();
  const pattern = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' #(\\d+)$');
  for (const n of existingNames) {
    const m = pattern.exec((n || '').trim());
    if (m) used.add(Number(m[1]));
  }
  let k = 1;
  while (used.has(k)) k++;
  return `${base} #${k}`;
}
