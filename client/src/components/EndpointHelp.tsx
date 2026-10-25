import { useEffect } from 'react';
import { DOCKER_ENDPOINT_HELP } from '../utils/startupGate';
import { useStartupStore } from '../stores/startupStore';

// Docker-aware hint under the local model endpoint fields. Own file to keep
// SettingsPanel under the size budget.
export function EndpointHelp({ id }: { id: string }) {
  return (
    <span id={id} style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
      {DOCKER_ENDPOINT_HELP}
    </span>
  );
}

// Scroll Settings to the section a deep link asked for (the banner's and the
// setup screen's PROVIDER SETTINGS buttons), then forget the request.
export function useSettingsSectionFocus(): void {
  const section = useStartupStore((s) => s.settingsSection);
  const setSection = useStartupStore((s) => s.setSettingsSection);
  useEffect(() => {
    if (!section) return;
    const el = document.querySelector<HTMLElement>(`[data-help=${JSON.stringify(`settings.${section}`)}]`) ?? document.getElementById(`connection-advanced-${section}`);
    if (el) {
      el.scrollIntoView({ block: 'start' });
      el.querySelector<HTMLElement>('input, button, select, textarea')?.focus({ preventScroll: true });
    }
    setSection(null);
  }, [section, setSection]);
}
