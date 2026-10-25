import { computerActivityControl } from '../voice/activity.js';
import { computerConditionControl } from '../voice/conditions.js';
import { computerMailRuleControl } from '../voice/mailRules.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LocalRecognizer, localVoiceAvailable, localWakeAvailable, voicePaths } from '../voice/localRecognizer.js';
import { readFile } from 'node:fs/promises';
import { endVoiceSession, getVoiceSession, interpretVoice, parseVoiceContext, renewVoiceSession, resolveOutputVoice, selectSessionOutputVoice, startVoiceSession, VOICE_EDGE_VOICE } from '../voice/sessions.js';
import { VOICE_OUTPUT_OPTIONS, VOICE_OUTPUT_SAMPLE } from '@archon/shared';
import { computerWatchControl } from '../voice/watches.js';
import { workflows } from '../server/state.js';
import { VOICE_LUNA_EFFORT, VOICE_LUNA_MODEL } from '../voice/luna.js';
import { requestVoiceTool } from '../voice/operatorTools.js';

async function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('Voice request exceeds its limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

let previewBusy = false;

// Routed after the normal operator cookie/origin gates. No agent/MCP access.
// Audio stays in memory. Explicit diagnostics/relays are logged below;
// Computer messages retain the chat's ordinary transcript.
export async function tryHandleVoiceRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/voice/')) return false;
  res.setHeader('Cache-Control', 'no-store');
  const send = (status: number, body: unknown): true => {
    if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
    return true;
  };
  // VOICE_AGENT_PLAN.md — relay for the archon-voice MCP child (loopback
  // only; exempt from the cookie gate like the cluster peer routes). The
  // Computer chat must exist and carry the voiceOperator flag; the browser
  // that owns the hands-free session answers.
  if (req.method === 'POST' && url.pathname === '/api/voice/tool') {
    const peer = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) return send(403, { ok: false, error: 'Loopback only.' });
    try {
      const body = JSON.parse((await readBytes(req, 40_000)).toString());
      const wf = typeof body.workflowId === 'string' ? workflows.get(body.workflowId) : undefined;
      if (!wf || wf.config.kind !== 'chat' || wf.config.voiceOperator !== true) return send(404, { ok: false, error: 'Not a Computer voice operator chat.' });
      const startedAt = Date.now();
      const outcome = await requestVoiceTool(body.workflowId, body.tool, body.args);
      // Every call and its answer in the journal: "the screen tool returned
      // an error" (2026-10-17) was undiagnosable without it.
      if (!wf.config.incognito) console.log(`[voice tool] ${String(body.tool)} ${JSON.stringify(body.args ?? {}).slice(0, 300)} → ${outcome.ok ? `ok ${outcome.result?.length ?? 0}B` : `ERROR ${outcome.error}`} ${Date.now() - startedAt}ms`);
      return send(200, outcome);
    } catch (e) { return send(400, { ok: false, error: e instanceof Error ? e.message : 'Invalid voice tool request.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/voice/status') {
    return send(200, { localSpeech: localVoiceAvailable(), fastWake: localWakeAvailable(), interpreter: 'codex', model: VOICE_LUNA_MODEL, effort: VOICE_LUNA_EFFORT,
      defaultVoice: VOICE_EDGE_VOICE, voices: VOICE_OUTPUT_OPTIONS });
  }
  try {
    if (url.pathname === '/api/voice/conditions' && ['GET','POST'].includes(req.method??'')) {
      const body=req.method==='POST'?JSON.parse((await readBytes(req,12000)).toString()):{action:'list'};
      return send(200,await computerConditionControl(url.searchParams.get('owner')??'',body));
    }
    if (url.pathname === '/api/voice/activity' && ['GET', 'POST'].includes(req.method ?? '')) {
      const body=req.method==='POST'?JSON.parse((await readBytes(req,1024)).toString()):{};
      return send(200,await computerActivityControl(url.searchParams.get('owner')??'',body));
    }
    if (url.pathname === '/api/voice/mail-rules' && ['GET', 'POST'].includes(req.method ?? '')) {
      const body = req.method === 'POST' ? JSON.parse((await readBytes(req, 4096)).toString()) : {};
      return send(200, await computerMailRuleControl(url.searchParams.get('owner') ?? '', body));
    }
    if (url.pathname === '/api/voice/watches' && ['GET', 'POST'].includes(req.method ?? '')) {
      const body = req.method === 'POST' ? JSON.parse((await readBytes(req, 2048)).toString()) : {};
      const owner = url.searchParams.get('owner') ?? '';
      return send(200, await computerWatchControl(owner, body.action ?? 'list', body.target, body.watch_id));
    }
    if (url.pathname === '/api/voice/preview' && req.method === 'POST') {
      const body = JSON.parse((await readBytes(req, 1024)).toString());
      const voice = resolveOutputVoice(body.voice);
      if (previewBusy) return send(409, { error: 'A voice sample is already being prepared.' });
      previewBusy = true;
      const speaker = new LocalRecognizer(true, voice);
      const abort = new AbortController(); res.once('close', () => abort.abort());
      try {
        // Audition without a lease, recognizer, microphone, or model call.
        // Never silently substitute Kokoro for the voice being compared.
        const out = await speaker.speakDetailed(VOICE_OUTPUT_SAMPLE, abort.signal);
        if (!res.destroyed) { res.writeHead(200, { 'Content-Type': out.mime, 'X-Voice-Engine': 'edge' }); res.end(out.audio); }
        return true;
      } finally { speaker.stop(); previewBusy = false; }
    }
    if (url.pathname === '/api/voice/ready-sound' && req.method === 'GET') {
      // Original selected cue, bundled so local TNG assets cannot override it.
      const wav = await readFile(new URL('../voice/capture-ready.wav', import.meta.url));
      res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(wav); return true;
    }
    if (url.pathname === '/api/voice/session' && req.method === 'POST') {
      const body = JSON.parse((await readBytes(req, 1024)).toString());
      if (body.enabled !== true) return send(400, { error: 'Explicit hands-free enable is required.' });
      if (!localVoiceAvailable()) return send(503, { error: 'Local speech is not installed. Run npm run voice:setup before enabling hands-free mode.' });
      return send(200, { sessionId: startVoiceSession(body.voice).id });
    }
    const id = url.searchParams.get('session') ?? '';
    if (url.pathname === '/api/voice/session' && req.method === 'DELETE') {
      endVoiceSession(id); return send(200, { ok: true });
    }
    const session = getVoiceSession(id);
    if (url.pathname === '/api/voice/heartbeat' && req.method === 'POST') {
      renewVoiceSession(id); return send(200, { ok: true });
    }
    // Pipeline diagnostics (2026-10-17): the browser's per-frame decisions
    // land in the journal next to the recognizer lines below, so a missed
    // wake word can be read back (`journalctl --user -u archon.service | grep '\[voice'`)
    // instead of guessed at. Local server, operator's own speech.
    const privateRequest = req.headers['x-archon-voice-private'] === '1';
    const vlog = (message: string) => { if (!privateRequest) console.log(`[voice ${id.slice(0, 8)}] ${message}`); };
    if (url.pathname === '/api/voice/diag' && req.method === 'POST') {
      const body = JSON.parse((await readBytes(req, 64_000)).toString());
      const events: unknown[] = Array.isArray(body?.events) ? body.events.slice(0, 200) : [];
      for (const event of events) vlog(`client ${JSON.stringify(event).slice(0, 1200)}`);
      return send(200, { ok: true });
    }
    const disconnected = new AbortController();
    res.once('close', () => disconnected.abort());
    const signal = AbortSignal.any([session.controller.signal, disconnected.signal]);
    if (url.pathname === '/api/voice/warmup' && req.method === 'POST') {
      let fastWake = localWakeAvailable();
      await Promise.all([session.recognizer.warmup(signal), session.speaker.warmup(signal).catch(() => {
        session.speaker.stop(); session.speaker = new LocalRecognizer(true);
      }), session.edgeSpeaker?.warmup(signal).catch(() => {
        session.edgeSpeaker?.stop(); session.edgeSpeaker = null;
      }), ...(fastWake ? [session.waker.warmup(signal).catch(() => {
        session.waker.stop(); fastWake = false;
      })] : [])]);
      signal.throwIfAborted();
      return send(200, { ready: true, fastWake, recognizer: voicePaths().model.includes('parakeet') ? 'Parakeet v3 · CPU' : 'Moonshine tiny · CPU', voice: session.edgeSpeaker ? `Edge ${session.edgeVoice}` : 'Kokoro · CPU' });
    }
    if (url.pathname === '/api/voice/wake' && req.method === 'POST') {
      const utterance = Number(url.searchParams.get('utterance'));
      const firstSpeechAt = Number(url.searchParams.get('firstSpeechAt') ?? '0.25');
      if (!Number.isSafeInteger(utterance) || utterance < 1 || utterance < session.wakeUtterance) return send(400, { error: 'Invalid wake utterance.' });
      if (!Number.isFinite(firstSpeechAt) || firstSpeechAt < 0 || firstSpeechAt > 0.5) return send(400, { error: 'Invalid wake speech offset.' });
      const pcm = await readBytes(req, 16_000);
      if (!pcm.length || pcm.length % 2) return send(400, { error: 'Expected a short PCM16 wake chunk.' });
      if (utterance < session.wakeUtterance) { vlog(`wake u=${utterance} stale (session at ${session.wakeUtterance})`); return send(400, { error: 'Stale wake utterance.' }); }
      if (session.waking) { vlog(`wake u=${utterance} busy`); return send(409, { error: 'Wake detection is busy.' }); }
      const reset = utterance !== session.wakeUtterance;
      session.wakeUtterance = utterance; session.waking = true;
      const started = Date.now();
      try {
        const detected = await session.waker.detectWake(pcm, reset, signal, firstSpeechAt);
        if (reset || detected) vlog(`wake u=${utterance} ${reset ? 'start' : ''}${detected ? ' DETECTED' : ''} firstSpeechAt=${firstSpeechAt} ${Date.now() - started}ms`);
        return send(200, { detected });
      } catch (error) {
        vlog(`wake u=${utterance} error ${error instanceof Error ? error.message : String(error)}`);
        session.waker.stop(); session.waker = new LocalRecognizer(false, 'emma', true); session.wakeUtterance = -1;
        throw error;
      } finally { session.waking = false; }
    }
    if (url.pathname === '/api/voice/speak' && req.method === 'POST') {
      const body = JSON.parse((await readBytes(req, 4000)).toString());
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 500) return send(400, { error: 'Speech output is limited to 500 characters per chunk.' });
      selectSessionOutputVoice(session, body.voice);
      // Edge neural voice first (VOICE_AGENT_PLAN.md); one failure demotes it
      // for the rest of the session and Kokoro takes over without a gap.
      const edgeSpeaker = session.edgeSpeaker;
      if (edgeSpeaker) {
        try {
          const out = await edgeSpeaker.speakDetailed(body.text, signal);
          if (!res.destroyed) { res.writeHead(200, { 'Content-Type': out.mime, 'X-Voice-Engine': 'edge' }); res.end(out.audio); }
          return true;
        } catch {
          edgeSpeaker.stop();
          // A cancelled old request must not demote a newly selected voice.
          if (session.edgeSpeaker === edgeSpeaker) session.edgeSpeaker = null;
          signal.throwIfAborted();
        }
      }
      try {
        const wav = await session.speaker.speak(body.text, signal);
        if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Voice-Engine': 'kokoro' }); res.end(wav); }
        return true;
      } catch (error) {
        session.speaker.stop(); session.speaker = new LocalRecognizer(true);
        throw error;
      }
    }
    if (url.pathname === '/api/voice/audio' && req.method === 'POST') {
      const pcm = await readBytes(req, 16000 * 2 * 30);
      if (!pcm.length || pcm.length % 2) return send(400, { error: 'Expected mono 16 kHz PCM16 audio.' });
      if (session.transcribing) { vlog(`audio ${pcm.length} bytes busy`); return send(409, { error: 'Speech recognition is busy.' }); }
      session.transcribing = true;
      const started = Date.now();
      try {
        const result = await session.recognizer.recognize(pcm, signal);
        vlog(`audio ${(pcm.length / 32000).toFixed(1)}s ${Date.now() - started}ms text=${JSON.stringify(result.text.slice(0, 300))} phrases=${JSON.stringify(result.phrases.slice(0, 200))}`);
        return send(200, result);
      } catch (error) {
        vlog(`audio ${(pcm.length / 32000).toFixed(1)}s error ${error instanceof Error ? error.message : String(error)}`);
        session.recognizer.stop(); session.recognizer = new LocalRecognizer();
        throw error;
      }
      finally { session.transcribing = false; }
    }
    if (url.pathname === '/api/voice/interpret' && req.method === 'POST') {
      const body = JSON.parse((await readBytes(req, 40_000)).toString());
      const context = parseVoiceContext(body.context);
      // Incognito stays on the deterministic/local path; its names/content
      // must never enter a provider CLI's operational/session state.
      if ([context.currentId, ...context.targets.map((t) => t.id)].some((wfid) => wfid && workflows.get(wfid)?.config.incognito)) {
        return send(400, { error: 'Use direct voice commands in Incognito; Luna interpretation is disabled there.' });
      }
      return send(200, await interpretVoice(session, body.text, context, signal));
    }
    return send(404, { error: 'Unknown voice operation.' });
  } catch (e) {
    return send(400, { error: e instanceof Error ? e.message : 'Voice operation failed.' });
  }
}
