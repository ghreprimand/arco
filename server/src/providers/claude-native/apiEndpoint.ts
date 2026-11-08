import { readSettings } from '../../settings.js';

export const NATIVE_PROVIDER_BASE_URL = 'https://api.anthropic.com';

// Saved login credentials only follow an operator-owned global setting.
// Project settings and the SDK's ambient endpoint variable cannot retarget them.
export async function nativeOAuthBaseUrl(): Promise<string> {
  return (await readSettings()).claudeNative?.baseUrl ?? NATIVE_PROVIDER_BASE_URL;
}
