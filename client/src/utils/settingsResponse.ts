import type { ArcoSettings } from '@arco/shared';

export function validateSettings(value: unknown): value is ArcoSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'error' in value) return false;
  const providers = (value as Partial<ArcoSettings>).enabledProviders;
  return !!providers && typeof providers === 'object' && !Array.isArray(providers)
    && Object.values(providers).every(flag => typeof flag === 'boolean');
}
