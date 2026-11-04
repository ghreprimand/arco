// Project-list requests used by Home. Every successful change answers with the
// whole project list, which replaces the one on screen. None of these routes
// deletes or moves files (server/src/http/projectRoutes.ts).

export type ProjectReply = { ok: true; body: unknown } | { ok: false; error: string };

export async function projectRequest(method: 'POST' | 'PATCH' | 'DELETE', url: string, body: Record<string, unknown>): Promise<ProjectReply> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data: unknown = await res.json().catch(() => null);
    if (res.ok && data && typeof data === 'object' && Array.isArray((data as { projects?: unknown }).projects)) return { ok: true, body: data };
    const error = (data as { error?: unknown } | null)?.error;
    return { ok: false, error: typeof error === 'string' && error ? error : `the server answered ${res.status}` };
  } catch {
    return { ok: false, error: 'the server could not be reached' };
  }
}

export const organize = (id: string, change: { displayName?: string; pinned?: boolean; archived?: boolean }) =>
  projectRequest('PATCH', '/api/projects', { id, ...change });
export const relocate = (id: string, path: string) => projectRequest('POST', '/api/projects/relocate', { id, path });
export const removeFromList = (path: string) => projectRequest('DELETE', '/api/projects', { path });
export const createFolder = (name: string) => projectRequest('POST', '/api/projects/create', name.startsWith('/') || /^[a-z]:[\\/]/i.test(name) || name.startsWith('\\\\') ? { path: name } : { name });
export const addFolder = (path: string) => projectRequest('POST', '/api/projects', { path });
