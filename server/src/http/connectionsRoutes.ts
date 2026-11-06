import type { IncomingMessage, ServerResponse } from 'http';
import type { ArcoSettings } from '@arco/shared';
import { getConnectionStatus } from '../auth.js';
import { patchSettings } from '../settings.js';
import { readConnectionCatalog } from '../connectionCatalog.js';
import { commandShell } from '../commandShell.js';

export async function tryHandleConnectionsRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url=new URL(req.url || '/', 'http://localhost');
  if (!['/api/connections','/api/connections/check'].includes(url.pathname)) return false;
  const reply=(code:number,body:unknown)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));return true;};
  if (url.pathname==='/api/connections/check') {
    if(req.method!=='POST')return reply(405,{error:'method not allowed'});
    try {
      const provider=url.searchParams.get('provider');
      const catalog=await readConnectionCatalog();
      const item=catalog.providers.find(p=>p.id===provider);
      if(!item)return reply(400,{error:'unknown connection'});
      if(catalog.deployment==='docker' && item.kind==='desktop')return reply(409,{error:'Choose a supported connection before checking.'});
      const status = await getConnectionStatus(item.id);
      const settings = item.id !== 'github' && status.loggedIn && !status.probeFailed
        ? await patchSettings({ providerConfirmed: true, enabledProviders: { [item.id]: true } as ArcoSettings['enabledProviders'] })
        : undefined;
      return reply(200,{provider:item.id,status,...(settings ? {settings} : {})});
    } catch {return reply(503,{error:'Connection check failed. Review prerequisites and retry.'});}
  }
  if(req.method!=='GET')return reply(405,{error:'method not allowed'});
  try {
    const shell=commandShell();
    return reply(200,{...await readConnectionCatalog(),...(shell.ok?(shell.notice?{commandShellNotice:shell.notice}:{}):{commandShellProblem:shell.problem})});
  }
  catch {return reply(503,{error:'Connection setup details are unavailable. Retry or open provider settings.'});}
}
