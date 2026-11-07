// Reads must reject HTTP errors before installing a successful-view payload.
export async function checkedJson<T>(response: Response, valid: (value: T) => boolean): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : `Request failed (${response.status})`);
  }
  let accepted = false;
  try { accepted = valid(body as T); } catch { /* Treat missing nested fields as invalid. */ }
  if (!accepted) throw new Error('The server returned an invalid response.');
  return body as T;
}
