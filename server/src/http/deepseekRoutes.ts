import type { IncomingMessage, ServerResponse } from 'node:http';
import { getDeepSeekBase } from '../providers/deepseek.js';
import { deepseekProfileManager, readDeepSeekProfiles } from '../providers/deepseekProfiles.js';
import { activeLocalWork } from '../localModels.js';
import { beginLocalModelUnload, localModelBusyMessage } from '../providers/localModelControl.js';
import { workflows } from '../server/state.js';
import { broadcastWorkflow } from '../server/broadcast.js';

// Ordinary cookie/origin gates run in the router before this operator surface.
export async function tryHandleDeepSeekRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/api/deepseek') return false;
  res.setHeader('Cache-Control', 'no-store');
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
  const notices: string[] = [];
  const notice = (content: string) => {
    notices.push(content);
    console.log(`[deepseek] ${content}`);
    for (const [workflowId, wf] of workflows) {
      if (wf.primary.provider === 'deepseek' && !wf.config.incognito) broadcastWorkflow(workflowId, { type: 'system_notice', workflowId, content });
    }
  };
  try {
    const base = await getDeepSeekBase();
    if (req.method === 'GET') return send(200, await deepseekProfileManager.snapshot(base));
    if (req.method !== 'POST') return send(405, { error: 'Use GET or POST.' });
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 2048) return send(413, { error: 'Request too large.' }); chunks.push(Buffer.from(chunk)); }
    let body: { action?: string; profile?: string };
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return send(400, { error: 'Invalid JSON.' }); }
    if (!body || !['load', 'unload'].includes(body.action ?? '') || (body.action === 'load' && !['exact', 'light'].includes(body.profile ?? ''))) return send(400, { error: 'Choose load with exact/light, or unload.' });
    if (activeLocalWork()) return send(409, { error: 'Finish or cancel active local model turns before managing DeepSeek.' });
    if (body.action === 'load') {
      const target = (await readDeepSeekProfiles(base))?.profiles.find((p) => p.id === body.profile);
      if (!target) return send(409, { error: 'No matching prepared DeepSeek profile.' });
      // An HTTP client disconnect is not a successful load. The manager stops
      // a partially started target and restores the prior loaded profile.
      const abort = new AbortController();
      const disconnected = () => { if (!res.writableEnded) abort.abort(); };
      res.once('close', disconnected);
      try { await deepseekProfileManager.ensure(base, target.model, abort.signal, notice, true); }
      finally { res.removeListener('close', disconnected); }
    } else {
      const release = beginLocalModelUnload();
      if (!release) return send(409, { error: localModelBusyMessage() });
      try {
        if (activeLocalWork()) return send(409, { error: 'A local turn started; nothing was stopped.' });
        notice(`DeepSeek ${await deepseekProfileManager.unload(base)}; service stopped and model memory released.`);
      } finally { release(); }
    }
    return send(200, { ...await deepseekProfileManager.snapshot(base), notices });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (req.method === 'POST') notice(`DeepSeek operation failed: ${error}`);
    return send(409, { error, notices });
  }
}
