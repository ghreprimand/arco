import { useEffect, useState } from 'react';
import type { ArcoSettings, ConnectionDefinition } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import { DOCKER_ENDPOINT_HELP } from '../../utils/startupGate';

export function EndpointEditor({ provider, docker, onSaved }: { provider: ConnectionDefinition; docker: boolean; onSaved: () => void }) {
  const settings = useAppStore(s=>s.settings), setSettings = useAppStore(s=>s.setSettings);
  const key = provider.endpointSetting!;
  const configured = settings?.[key]?.baseUrl ?? '';
  const editable = (()=>{try{const url=new URL(configured);return ['http:','https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;}catch{return !configured;}})();
  const [draft,setDraft] = useState(editable ? configured : ''), [busy,setBusy] = useState(false), [note,setNote] = useState('');
  useEffect(()=>{ setDraft(editable ? configured : ''); },[configured,key,editable]);
  const save = async () => {
    let value = draft.trim().replace(/\/+$/,'');
    if (value) {
      try { const url = new URL(value); if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(); }
      catch { setNote('Enter an http or https service URL without credentials, query parameters or a fragment. Advanced settings retain indirect configuration.'); return; }
    }
    setBusy(true);setNote('');
    try {
      const res=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({[key]:value ? {baseUrl:value} : {}})});
      const body=await res.json();
      if (!res.ok || !body?.enabledProviders) throw new Error();
      setSettings(body as ArcoSettings);setNote('Endpoint saved. Test the connection to check this address.');onSaved();
    } catch { setNote('Endpoint was not saved. Check the server connection and retry. Your draft is kept.'); }
    finally {setBusy(false);}
  };
  if(!editable)return <p>This address uses advanced or credential-bearing configuration. Review it in Advanced runtime settings; the value is not shown here.</p>;
  const placeholder = key === 'ollama' ? (docker ? 'http://host.docker.internal:11434' : 'http://localhost:11434') : key === 'lmstudio' ? (docker ? 'http://host.docker.internal:1234' : 'http://localhost:1234') : 'http://model-service:8000';
  return <form onSubmit={e=>{e.preventDefault();void save();}} className="connections-endpoint">
    <label htmlFor={`connection-endpoint-${provider.id}`}>Model server address</label>
    <input id={`connection-endpoint-${provider.id}`} value={draft} placeholder={placeholder} onChange={e=>setDraft(e.target.value)} disabled={busy} spellCheck={false} />
    <button type="submit" disabled={busy}>{busy?'Saving...':'Save endpoint'}</button>
    <p>Leave empty to use the runtime default. Changes affect future provider connections.</p>
    {docker && <p>{DOCKER_ENDPOINT_HELP}</p>}
    <p role="status">{note}</p>
  </form>;
}
