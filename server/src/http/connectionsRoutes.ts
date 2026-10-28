import type { IncomingMessage, ServerResponse } from 'http';
import type { AuthLoginTarget } from '@arco/shared';
import { getConnectionStatus } from '../auth.js';
import { readSettings, patchSettings } from '../settings.js';
import { readConnectionCatalog } from '../connectionCatalog.js';

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
      const settings=await readSettings();
      if((provider!=='github' && settings.enabledProviders[provider as Exclude<AuthLoginTarget,'github'>]===false) || (catalog.deployment==='docker' && item.kind==='desktop'))return reply(409,{error:'Enable this provider or choose a supported connection before checking.'});
      const status = await getConnectionStatus(item.id);
      if (item.id !== 'github' && status.loggedIn) await patchSettings({ providerConfirmed: true });
      return reply(200,{provider:item.id,status});
    } catch {return reply(503,{error:'Connection check failed. Review prerequisites and retry.'});}
  }
  if(req.method!=='GET')return reply(405,{error:'method not allowed'});
  try {return reply(200,await readConnectionCatalog());}
  catch {return reply(503,{error:'Connection setup details are unavailable. Retry or open provider settings.'});}
}
