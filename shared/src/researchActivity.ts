// Identify search calls in the provider activity shown to the operator.
// A multiplexed web tool can also open pages, which are not searches.
export function researchSearchDetails(tool: string | undefined, input: unknown): { search: boolean; query?: string } {
  if (!tool) return { search: false };
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = typeof input === 'string' ? JSON.parse(input) : input;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch { /* An unparseable call has no recorded query. */ }
  if (tool === 'web_search' || tool === 'WebSearch') {
    const query = args.query ?? args.searchTerm;
    return { search: true, ...(typeof query === 'string' ? { query } : {}) };
  }
  if (tool !== 'codex_apps/search_service.web_run' && tool !== 'web.run') return { search: false };
  for (const key of ['system2_search_query', 'search_query', 'image_query']) {
    const entries = args[key];
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const first = entries[0];
    const query = first && typeof first === 'object' ? (first as Record<string, unknown>).q : undefined;
    return { search: true, ...(typeof query === 'string' ? { query } : {}) };
  }
  return { search: false };
}
