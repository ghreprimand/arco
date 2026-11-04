// Same-origin attachment upload. Always posts to `/upload` on the page origin
// so the session cookie rides along and a foreign process on :3001 never sees
// the file. Vite proxies `/upload` to ARCO_PORT in dev; production serves it
// from the same host as the client.

export type UploadedFile = { fileId: string; filename: string; path: string };

export type UploadResult =
  | ({ ok: true } & UploadedFile)
  | { ok: false; error: string };

/** Relative path used for every attachment POST. Never include a host or port. */
export const UPLOAD_PATH = '/upload';

function fileLabel(file: File): string {
  return file.name?.trim() || 'pasted file';
}

function reasonFromBody(body: unknown, status: number): string {
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    const message = (body as { error: string }).error.trim();
    if (message) {
      if (/empty/i.test(message)) return 'empty file';
      if (/too large|byte cap|size/i.test(message)) return 'file is too large';
      return message;
    }
  }
  if (status === 413) return 'file is too large';
  if (status === 401 || status === 403) return `refused (HTTP ${status})`;
  if (status >= 500) return `server error (HTTP ${status})`;
  return `HTTP ${status}`;
}

export function formatUploadFailure(file: File, reason: string): string {
  return `Upload failed for ${fileLabel(file)}: ${reason}`;
}

/**
 * POST `file` to same-origin `/upload`. Returns a staged path on success, or a
 * visible error string naming the file and the failure reason.
 */
export async function uploadAttachment(file: File, fetchImpl: typeof fetch = fetch): Promise<UploadResult> {
  let res: Response;
  try {
    res = await fetchImpl(UPLOAD_PATH, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'X-Filename': file.name || 'upload',
        'Content-Type': file.type || 'application/octet-stream',
      },
      body: file,
    });
  } catch {
    return { ok: false, error: formatUploadFailure(file, 'network error') };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    return { ok: false, error: formatUploadFailure(file, reasonFromBody(body, res.status)) };
  }

  const record = body as { fileId?: unknown; filename?: unknown; path?: unknown } | null;
  if (
    !record
    || typeof record.fileId !== 'string'
    || typeof record.filename !== 'string'
    || typeof record.path !== 'string'
  ) {
    return { ok: false, error: formatUploadFailure(file, 'unexpected server response') };
  }

  return { ok: true, fileId: record.fileId, filename: record.filename, path: record.path };
}
