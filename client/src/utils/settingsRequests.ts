import type { ArcoSettings } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { validateSettings } from './settingsResponse';

export async function readSavedSettings(response: Response): Promise<ArcoSettings> {
  try {
    if (!response.ok) throw new Error('Settings could not be saved. Previous settings remain active.');
    const value: unknown = await response.json();
    if (!validateSettings(value)) throw new Error('The settings response was incomplete. Previous settings remain active.');
    return value;
  } catch (error) {
    useAppStore.getState().pushNotification('error', error instanceof Error ? error.message : 'Settings could not be saved.');
    throw error;
  }
}

// Build each patch after the preceding reply so rapid edits use the latest saved state.
let settingsSaveTail: Promise<unknown> = Promise.resolve();
export function queueSettingsPatch(build: (settings: ArcoSettings) => Partial<ArcoSettings>): Promise<boolean> {
  const operation = settingsSaveTail.then(async () => {
    const current = useAppStore.getState().settings;
    if (!current) return false;
    try {
      const response = await fetch('/api/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(build(current)),
      });
      useAppStore.getState().setSettings(await readSavedSettings(response));
      return true;
    } catch {
      useAppStore.getState().pushNotification('error', 'Settings could not be saved. Retry the change.');
      return false;
    }
  });
  settingsSaveTail = operation.catch(() => {});
  return operation;
}
