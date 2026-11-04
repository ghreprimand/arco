import type { ArcoSettings } from '@arco/shared';
import { useAppStore } from '../stores/appStore';

// Store only a completion bit under the server home, shared by all browsers.
export async function completeOnboarding(): Promise<void> {
  const res = await fetch('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ onboardingComplete: true }),
  });
  const body = await res.json() as ArcoSettings;
  if (!res.ok || body?.onboardingComplete !== true) throw new Error('Setup completion could not be saved. Check the server and retry.');
  useAppStore.getState().setSettings(body);
}
