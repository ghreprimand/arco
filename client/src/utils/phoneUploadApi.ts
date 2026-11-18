// The desktop page keeps its upload ownership when its normal operator cookie
// refreshes. The server still requires a valid operator cookie on every call.
let owner: string | undefined;

export function phoneUploadRequest(path = '', init: RequestInit = {}): Promise<Response> {
  owner ??= Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  const headers = new Headers(init.headers);
  headers.set('X-Arco-Phone-Owner', owner);
  return fetch('/api/phone-upload' + path, { ...init, headers });
}
