// Is this page running in a Chromium-family browser (Chrome, Edge, Brave,
// Vivaldi, Chromium, Opera)? Detected in the page so a Firefox or Safari tab
// opened by hand is recognized too, not only one opened by `arco open`.
export interface BrowserNavigator {
  userAgent?: string;
  userAgentData?: { brands?: Array<{ brand: string }> } | null;
}

export function isChromiumBrowser(nav: BrowserNavigator | undefined): boolean {
  if (!nav) return true;
  // User-Agent Client Hints exist only in Chromium-family browsers; the
  // "Chromium" brand is present in every one of them.
  const brands = nav.userAgentData?.brands;
  if (Array.isArray(brands) && brands.length) return brands.some((b) => /chromium|google chrome|microsoft edge/i.test(b.brand));
  const ua = nav.userAgent ?? '';
  if (/Firefox\/|FxiOS\//.test(ua)) return false;
  return /\b(?:Chrome|Chromium|CriOS|Edg|EdgA|EdgiOS)\//.test(ua);
}

// The notice is dismissed once per browser: localStorage belongs to one
// browser (and profile), which is the scope wanted here.
export const BROWSER_NOTICE_KEY = 'arco.browserNotice.dismissed';
