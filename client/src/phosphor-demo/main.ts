// Install the fixture boundary BEFORE importing any production store/component.
// Each document gets fresh storage; no production cache or workflow is rehydrated.
const preferences = new Map<string, string>();
for (const key of ['archon_crisp_text', 'archon_font_pack_override']) {
  try { const v = localStorage.getItem(key); if (v !== null) preferences.set(key, v); } catch { /* unavailable */ }
}
function memoryStorage(): Storage {
  const values = new Map(preferences);
  return {
    get length() { return values.size; },
    key: i => [...values.keys()][i] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); }, clear: () => values.clear(),
  };
}
Object.defineProperty(window, 'localStorage', { value: memoryStorage() });
Object.defineProperty(window, 'sessionStorage', { value: memoryStorage() });
window.fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.origin === location.origin && url.pathname === '/api/file-content') {
    const { files } = await import('./fixtures');
    const path = url.searchParams.get('path') ?? '';
    const content = files[path.replace('/demo/Archon/', '')];
    return Response.json(content === undefined ? { type: 'error', error: 'This file is outside the synthetic fixture.' } : { type: 'text', content, size: new TextEncoder().encode(content).length });
  }
  return Response.json({ error: 'Operation stubbed in design preview.' }, { status: 403 });
};
// Vite already owns its HMR socket. Components cannot create control/PTY sockets.
window.WebSocket = class { constructor() { throw new Error('Workflow connections are disabled in this preview.'); } } as unknown as typeof WebSocket;
void import('./Demo');
