import { useEffect, useState } from 'react';
import { PRIMARY_PROVIDERS } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import { useAppUpdateStore } from '../../stores/appUpdateStore';
import { useStartupStore } from '../../stores/startupStore';
import { PROVIDER_LABELS } from '../../utils/startupGate';

export function HomeStatus() {
  const auth = useAppStore(s => s.authStatus);
  const settings = useAppStore(s => s.settings);
  const update = useAppUpdateStore(s => s.status);
  const [version, setVersion] = useState('');
  const providers = PRIMARY_PROVIDERS.filter(p => settings?.enabledProviders?.[p] !== false && auth?.[p]?.loggedIn);
  useEffect(() => {
    let alive = true;
    void fetch('/api/app/version').then(r => r.ok ? r.json() : null).then(body => {
      if (alive && typeof body?.version === 'string') setVersion(body.version);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const versions = () => {
    useStartupStore.getState().setSettingsSection('cli-versions');
    useAppStore.getState().setShowSettings(true);
  };
  return <div className="home-status" aria-label="Workbench status">
    <a href="#connections" title={providers.map(p => PROVIDER_LABELS[p]).join(', ')}>
      <span className={`home-status-light${providers.length ? ' ready' : ''}`} />
      {!auth ? 'Checking connections' : providers.length ? `${providers.length} provider${providers.length === 1 ? '' : 's'} ready` : 'No provider connected'}
      <span className="home-status-link">Connections</span>
    </a>
    <button type="button" onClick={versions}>Arco{update?.current || version ? ` v${(update?.current || version).replace(/^v/, '')}` : ''}{update?.enabled && settings?.updateCheck !== false && update.updateAvailable ? ' / Update available' : ''}</button>
  </div>;
}
