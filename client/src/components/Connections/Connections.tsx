import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArcoSettings, AuthLoginResult, AuthLoginTarget, ConnectionCatalog } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import { useStartupStore } from '../../stores/startupStore';
import { LoginFlow } from '../LoginFlow';
import { WorkSurfaceControls } from '../workSurface/WorkSurfaceControls';
import { LoginCommand } from '../LoginCommand';
import { EndpointEditor } from './EndpointEditor';
import { connectionState, credentialSource, KINDS, parseConnectionCatalog, parseConnectionStatus, safeEndpoint } from './model';

export function useConnectionsDeepLinks() {
  useEffect(()=>{
    const open = () => {
      const match = /^#connections(?:\/([a-z]+))?$/.exec(window.location.hash);
      if (!match) return;
      const ids = ['claude','codex','gemini','cursor','ollama','lmstudio','strata','llamacpp','deepseek','antigravity','github'];
      if (match[1] && !ids.includes(match[1])) return;
      useStartupStore.getState().openConnections(match[1] as AuthLoginTarget | undefined);
    };
    open();window.addEventListener('hashchange',open);return()=>window.removeEventListener('hashchange',open);
  },[]);
}

export function Connections({ mode='gate', onContinue, onSkip, canContinue = false }: { mode?:'gate'|'dialog'; onContinue?: () => void; onSkip?: () => void; canContinue?: boolean }) {
  const auth = useAppStore(s=>s.authStatus), settings = useAppStore(s=>s.settings);
  const setAuth = useAppStore(s=>s.setAuthStatus), setSettings = useAppStore(s=>s.setSettings);
  const connected = useAppStore(s=>s.connected);
  const settingsOpen = useAppStore(s=>s.showSettings);
  const selected = useStartupStore(s=>s.setupProvider) ?? 'claude';
  const [catalog,setCatalog] = useState<ConnectionCatalog | null>(null);
  const [catalogError,setCatalogError] = useState(''), [note,setNote] = useState('');
  const [checking,setChecking] = useState(false), [enabling,setEnabling] = useState(false);
  const [login,setLogin] = useState<AuthLoginResult | null>(null), [starting,setStarting] = useState(false);
  const [query,setQuery] = useState('');
  const alive = useRef(true), version = useRef(0), checkingRef = useRef(false);
  const dialog = useRef<HTMLDivElement>(null), opener = useRef<HTMLElement | null>(null);
  const provider = catalog?.providers.find(p=>p.id===selected);
  const enabled = selected==='github' || settings?.enabledProviders[selected] !== false;
  const status = auth?.[selected];
  const unavailable = catalog?.deployment==='docker' && provider?.kind==='desktop';
  const loadCatalog = useCallback(async () => {
    try {
      const res=await fetch('/api/connections',{cache:'no-store'});
      const body=parseConnectionCatalog(await res.json());
      if(!res.ok || !body) throw new Error();
      if(alive.current){setCatalog(body);setCatalogError('');}
    } catch {if(alive.current)setCatalogError('Connection setup details could not be loaded. Retry, or use provider settings.');}
  },[]);
  useEffect(()=>{
    alive.current=true;opener.current=document.activeElement as HTMLElement | null;
    dialog.current?.focus();void loadCatalog();
    return()=>{alive.current=false;version.current++;if(opener.current?.isConnected)opener.current.focus();};
  },[loadCatalog]);
  useEffect(()=>{if(connected)void loadCatalog();},[connected,loadCatalog]);
  useEffect(()=>{version.current++;setLogin(null);setStarting(false);setNote('');},[selected]);
  const refresh = useCallback(async (target?:AuthLoginTarget) => {
    if(checkingRef.current)return;
    checkingRef.current=true;setChecking(true);setNote('Checking provider status...');
    try {
      if(target){
        const res=await fetch(`/api/connections/check?provider=${target}`,{method:'POST'});
        const body=await res.json();
        if(!res.ok || body?.provider!==target || typeof body?.status?.loggedIn!=='boolean')throw new Error();
        const previous=useAppStore.getState().authStatus;
        if(alive.current && previous)setAuth({...previous,[target]:body.status});
      }else{
        const res=await fetch('/api/auth-status',{cache:'no-store'});
        const body=parseConnectionStatus(res.ok,await res.json());
        if(!body)throw new Error();
        if(alive.current)setAuth(body);
      }
      if(alive.current){setNote('Status refreshed. Detection does not test a model turn or establish billing.');void loadCatalog();}
    } catch {if(alive.current)setNote('Status could not be checked. Previous results may be out of date. Check that Arco is running, then retry.');}
    finally {checkingRef.current=false;if(alive.current)setChecking(false);}
  },[setAuth,loadCatalog]);
  // LoginFlow owns its provider session. Poll status only while an explicitly
  // started login is shown, and stop after ten minutes or on leaving the screen.
  useEffect(()=>{
    if(!login || status?.loggedIn)return;
    const deadline=Date.now()+10*60*1000;
    const timer=setInterval(()=>{if(Date.now()>=deadline){clearInterval(timer);return;}void refresh(selected);},1500);
    return()=>clearInterval(timer);
  },[login,status?.loggedIn,refresh,selected]);
  const leave = () => {
    if (onSkip) { onSkip(); return; }
    const startup=useStartupStore.getState();
    if(mode==='gate'){startup.setSetupDeferred(true);useAppStore.setState({activeJobId:null,activeClusterId:null});}
    startup.setSetupOpen(false);
    if(window.location.hash.startsWith('#connections'))window.history.replaceState(null,'',window.location.pathname+window.location.search);
  };
  const choose = (id:AuthLoginTarget) => {
    version.current++;setLogin(null);setStarting(false);setNote('');
    useStartupStore.setState({setupProvider:id});
    window.history.replaceState(null,'',`#connections/${id}`);
  };
  const advanced = (section:string) => {
    useStartupStore.getState().setSettingsSection(section);useAppStore.getState().setShowSettings(true);
  };
  const startLogin = async () => {
    if(starting || !provider?.login)return;
    setStarting(true);setNote('Starting provider sign-in...');setLogin(null);
    const current=++version.current;
    try {
      const res=await fetch(`/api/auth-login?provider=${selected}&inApp=1`,{method:'POST'});
      const body=await res.json() as AuthLoginResult;
      if(!res.ok || (!body.session && !body.command && !body.manual))throw new Error();
      if(alive.current && version.current===current){setLogin(body);setNote(body.manual ?? 'Finish the provider sign-in, then refresh status.');}
    } catch {if(alive.current && version.current===current)setNote('Sign-in could not be started. Check the runtime prerequisites, retry, or open provider settings.');}
    finally {if(alive.current && version.current===current)setStarting(false);}
  };
  const toggleEnabled = async () => {
    if(enabling || selected==='github' || !settings)return;
    setEnabling(true);
    try {
      const res=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabledProviders:{...settings.enabledProviders,[selected]:!enabled}})});
      const body=await res.json();if(!res.ok || !body?.enabledProviders)throw new Error();
      if(alive.current){setSettings(body as ArcoSettings);setNote(enabled?'Provider disabled for new work. Existing work is not deleted.':'Provider enabled. Refresh status to check its setup.');}
    }catch{if(alive.current)setNote('Provider availability was not saved. Retry when the server is reachable.');}
    finally{if(alive.current)setEnabling(false);}
  };
  const trap = (e:React.KeyboardEvent) => {
    if(e.key==='Escape'){e.stopPropagation();leave();return;}
    if(e.key!=='Tab' || !dialog.current)return;
    const list=[...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),summary,[tabindex="0"]')].filter(el=>el.getClientRects().length>0);
    const first=list[0],last=list.at(-1);
    if(e.shiftKey && (document.activeElement===first || document.activeElement===dialog.current)){e.preventDefault();last?.focus();}
    else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first?.focus();}
  };
  return <div className="connections-backdrop" inert={settingsOpen} aria-hidden={settingsOpen || undefined}>
    <div className="connections-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="provider-setup-title" aria-describedby="provider-setup-intro" tabIndex={-1} onKeyDown={trap} data-help="auth.connections">
      <header className="connections-header"><div><h1 id="provider-setup-title">{mode==='gate'?'Welcome - Connections':'Connections'}</h1>
        <p id="provider-setup-intro">Connect an AI tool, choose a project, then start work. Provider sign-in, API credentials, local services and tool accounts are different access paths.</p>
        {mode==='gate' && <div role="status">{canContinue ? 'PROVIDER CONNECTED - already signed in; continue to use this provider.' : 'NO PROVIDER CONNECTED YET'}</div>}
      </div><WorkSurfaceControls surface={dialog} /><button type="button" onClick={leave}>{mode==='gate'?'SKIP FOR NOW':'CLOSE'}</button></header>
      {onContinue && <p className="connections-scope">Step 2 of 3: connect a provider. Continue after an enabled AI provider reports connected, or skip this step.</p>}
      <p className="connections-scope">Connections apply to the Arco server. Your projects and saved work remain available. Checks do not send a prompt or prove model access.</p>
      <div className="connections-actions"><button type="button" onClick={()=>void refresh()} disabled={checking} aria-busy={checking}>{checking?'Checking...':'Refresh all statuses'}</button>
        <button type="button" onClick={()=>advanced('authentication')}>PROVIDER SETTINGS</button>
        <button type="button" onClick={()=>advanced('enabled-providers')}>All provider controls</button></div>
      <div aria-live="polite" role="status" className="connections-note">{note}</div>
      {catalogError && <div role="alert">{catalogError} <button type="button" onClick={()=>void loadCatalog()}>Retry setup details</button></div>}
      {!catalog && !catalogError && <p role="status">Loading connection setup...</p>}
      <div className="connections-body">
        <nav aria-label="Connections"><label htmlFor="connection-search">Find a connection</label><input id="connection-search" type="search" value={query} onChange={e=>setQuery(e.target.value)} />
          {KINDS.map(kind=><section key={kind.id} aria-label={kind.label}><h2>{kind.label}</h2><p>{kind.description}</p>
            {catalog?.providers.filter(p=>p.kind===kind.id && `${p.label} ${p.access}`.toLowerCase().includes(query.toLowerCase())).map(p=><button type="button" key={p.id} onClick={()=>choose(p.id)} aria-pressed={selected===p.id}>
              <strong>{p.label}</strong><span>{connectionState(p,auth?.[p.id],p.id==='github' || settings?.enabledProviders[p.id]!==false,catalog.deployment==='docker')}</span>
            </button>)}
          </section>)}
          {catalog && !catalog.providers.some(p=>`${p.label} ${p.access}`.toLowerCase().includes(query.toLowerCase())) && <p role="status">No matching connections. Clear the search to show all providers.</p>}
        </nav>
        {provider && catalog && <section className="connection-detail" aria-label={`${provider.label} connection`} key={provider.id}>
          <h2>{provider.label}</h2><p role="status">{connectionState(provider,status,enabled,catalog.deployment==='docker')}</p>
          <p>{provider.access}</p><h3>1. Check the prerequisites</h3><p>{provider.prerequisite}</p>
          {unavailable && <p role="alert">Unavailable in the stock Docker runtime. Use a supported connection or an explicitly configured host integration.</p>}
          {!enabled && <p>This provider is disabled. Enable it before starting new work.</p>}
          {selected!=='github' && <button type="button" onClick={()=>void toggleEnabled()} disabled={enabling || !settings}>{enabled?'Disable provider':'Enable provider'}</button>}
          <h3>2. Connect</h3><p>{credentialSource(provider,status,catalog)}</p>
          {status?.email && <p>Reported account: {status.email}{status.orgName ? ` - ${status.orgName}`:''}</p>}
          {status?.accountStatuses?.length ? <ul aria-label="Configured account statuses">{status.accountStatuses.map(a=><li key={a.id}>{a.label}: {a.loggedIn?'connected':'not connected'}{a.email ? ` - ${a.email}`:''}</li>)}</ul>:null}
          {provider.environmentKey && catalog.environmentKeys.includes(provider.environmentKey) && <p role="note">{provider.environmentKey} is present in the server environment. It can change credential selection for some transports. Review the provider-reported source above; billing is not inferred.</p>}
          {provider.login && !status?.accountStatuses?.length && <button type="button" disabled={!enabled || unavailable || starting} onClick={()=>void startLogin()}>{starting?'Starting sign-in...':status?.loggedIn?'Sign in again':`Sign in to ${provider.label}`}</button>}
          {status?.accountStatuses?.length ? <p>Sign in to a specific configured profile in Accounts and profiles. Its credentials stay separate from the default account.</p>:null}
          {login && <div className="connection-login">{login.session ? <LoginFlow result={login} onRestart={()=>void startLogin()} />:login.command ? <LoginCommand command={login.command} hostCommand={login.hostCommand}/>:null}</div>}

          {provider.endpointSetting && <EndpointEditor key={provider.id} provider={provider} docker={catalog.deployment==='docker'} onSaved={()=>setNote('Address saved. Use Test connection to check the service.')}/>}
          {provider.kind==='local' && <p>{(status?.installedModels?.length ?? 0)} models reported by the current status check. Model availability and a successful turn require separate acceptance.</p>}
          {status?.apiProvider && provider.kind==='local' && <p>Configured address: {safeEndpoint(status.apiProvider.slice(status.apiProvider.indexOf(':')+1)) || 'See advanced runtime settings'} {status.loggedIn && (status.installedModels?.length ?? 0) > 0 ? `(reachable, ${status.installedModels!.length} models)` : '(not reachable)'}</p>}
          {provider.environmentKey && <details><summary>API credentials instead of sign-in</summary><p>Configure {provider.environmentKey} in the Arco server environment and restart the runtime. Keep the value out of project files. Environment credentials can take precedence over sign-in; consult the provider guide and check the reported source.</p><button type="button" onClick={()=>advanced('authentication')}>Advanced credential settings</button></details>}
          <h3>3. Check and recover</h3><button type="button" onClick={()=>void refresh(selected)} disabled={checking || !enabled || unavailable}>{checking?'Checking...':provider.kind==='local'?'Test connection':'Check connection'}</button>
          <p>{provider.recovery}</p>
          {provider.id==='codex' && <p>Subscription quota requires an installed, current Codex CLI and a connected ChatGPT account. API-key usage is billed separately. After connecting, the Codex status dot shows quota and an optional legacy browser source. <a href="https://chatgpt.com/settings/usage?tab=overview" target="_blank" rel="noreferrer">Open ChatGPT usage</a>.</p>}
          <button type="button" onClick={()=>advanced(provider.settingsSection)}>{provider.id==='codex'?'Accounts and profiles':provider.kind==='local'?'Advanced runtime settings':'Advanced provider settings'}</button>
          {provider.kind==='local' && <button type="button" onClick={()=>advanced('ollama')}>Discover endpoints</button>}
          <button type="button" onClick={()=>advanced('transport-defaults')}>Transport defaults</button>
          <button type="button" onClick={()=>advanced('cli-versions')}>Runtime versions</button>
          {provider.officialUrl && <p><a href={provider.officialUrl} target="_blank" rel="noreferrer">Official setup guide</a> - guidance checked {catalog.checkedOn}</p>}
          <p><a href={`#connections/${provider.id}`}>Link to this connection</a></p>
        </section>}
      </div>
      <footer>{onContinue ? <button type="button" onClick={onContinue} disabled={!canContinue}>Continue to chat</button> : <button type="button" onClick={leave}>{mode==='gate'?'Continue to workspace':'Back to workspace'}</button>}<span>No workflow starts until you launch it in the creator.</span></footer>
    </div>
  </div>;
}
