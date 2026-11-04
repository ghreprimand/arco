// Shared formatting for the usage dropdowns (Claude, Codex).

function formatTime(d: Date): string {
  const hours = d.getHours();
  const mins = d.getMinutes();
  const h12 = hours % 12 || 12;
  const ampm = hours < 12 ? 'a.m.' : 'p.m.';
  return `${h12}:${mins.toString().padStart(2, '0')} ${ampm}`;
}

/** Local-time reset label: "3:05 p.m." today, "Sat 3:05 p.m." otherwise. */
export function formatResetLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const time = formatTime(d);
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** Turn a reset phrase into local time when it is an ISO timestamp; otherwise keep it. */
export function formatResetText(text: string, now: Date = new Date()): string {
  const trimmed = text.trim();
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed) && !Number.isNaN(new Date(trimmed).valueOf())) return formatResetLabel(trimmed, now);
  return trimmed;
}
