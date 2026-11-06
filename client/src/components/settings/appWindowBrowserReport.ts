// The GET /api/app-browsers reply for Settings > Advanced > App window browser.
export interface BrowserView { id: string; name: string; path: string }
export interface Report { platform: string; choice: string | null; browsers: BrowserView[]; using: BrowserView | null; missing: boolean; unsupported?: boolean }

function isBrowser(value: unknown): value is BrowserView {
  const b = value as BrowserView | null;
  return !!b && typeof b.id === 'string' && typeof b.name === 'string' && typeof b.path === 'string';
}

// The reply as a Report, or null when it does not have that shape (an older
// or unexpected server). A malformed reply must not take Settings down with it.
export function toReport(value: unknown): Report | null {
  const v = value as Partial<Report> | null;
  if (!v || typeof v !== 'object' || !Array.isArray(v.browsers)) return null;
  return {
    platform: typeof v.platform === 'string' ? v.platform : '',
    choice: typeof v.choice === 'string' && v.choice ? v.choice : null,
    browsers: v.browsers.filter(isBrowser),
    using: isBrowser(v.using) ? v.using : null,
    missing: v.missing === true,
    ...(v.unsupported === true ? { unsupported: true } : {}),
  };
}
