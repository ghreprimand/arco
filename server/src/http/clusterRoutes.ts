import { readQuickPromotion, requestQuickPromotion } from '../research/quickPromotion.js';
import { previewResearchExport, prepareResearchExport, confirmResearchExport } from '../research/exportResults.js';
import { antigravityChatWorkspace } from '../chatMode.js';
import { sendResearchToFolder, sendResearchToPlan, stageResearchForComposer, confirmResearchComposer, recordResearchExport, previewResearchStart, prepareResearchStart, confirmResearchStart } from '../research/sendToProject.js';
import type { ResearchSelection } from '../research/resultSelection.js';
import { existingClusterMemberRefusal } from '../existingClusterMembers.js';
import { recipientContext } from '../peerRecipientContext.js';
import { extendRound, retryResearcher, isResearchMemberBusy, revealResearch, startRound } from '../research/researchRounds.js';
import { closeResearch, unsentFiles } from '../research/researchClose.js';
import { researchSummaries } from '../research/researchFolder.js';
import { loadResearch } from '../research/researchState.js';
import { forgetProject, libraryRows, liveResearchClusters, locateProject, reopenPreview } from '../research/researchLibrary.js';
import { formatResearchRoundResult, researchHeldNote, researchSendProposal, clearResearchSendProposal, proposeResearchSend } from '../research/researchTools.js';
import { spawn } from 'child_process';
import { disabledClusterProvider, localCapacityRefusal, memberProvider } from '../localCapacity.js';
import { promises as fs } from 'fs';
import { isClusterOpen } from '../workspace.js';
import { IncomingMessage, ServerResponse } from 'http';
import * as clusterMailbox from '../clusterMailbox.js';
import * as clusterPeerOps from '../clusterPeerOps.js';
import * as clusterStore from '../clusterStore.js';
import { getSandboxDbPath, getSandboxStore } from '../providers/claude-native/sandboxStore.js';
import {
  broadcastCluster,
  broadcastWorkflow,
  notifyClusterStateForWorkflow,
} from '../server/broadcast.js';
import { PORT } from '../server/constants.js';
import {
  workflowCwds,
  workflows,
} from '../server/state.js';
import { readMeta, updateMeta } from '../workflowMeta.js';
import { formatBoardForModel } from '../project/taskLedger.js';
import type { HttpDeps } from './router.js';
import type { LedgerTaskStatus, TaskLink } from '@arco/shared';

// Cluster / sandbox / codebase-memory route group — peeled verbatim from
// router.ts (see docs/ARCHITECTURE.md). Returns true when a route
// in this group matched (request answered), false otherwise so the caller
// falls through to the next route group.
export async function tryHandleClusterRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpDeps,
): Promise<boolean> {
  const savedPromotion = req.url ? /^\/api\/research\/saved-quick\/([0-9a-f-]{36})\/keep-as-project$/.exec(req.url.split('?')[0]) : null;
  if (savedPromotion && (req.method === 'GET' || req.method === 'POST')) {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      const saved = await import('../research/savedQuickPromotion.js');
      if (req.method === 'GET') { const status = await saved.savedQuickStatus(savedPromotion[1]); reply(status ? 200 : 404, status ?? { error: 'unknown_chat' }); }
      else {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 16 * 1024) throw new Error('Request is too large.'); chunks.push(bytes); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { folderRoot?: string };
        const journal = await saved.requestSavedQuickPromotion(savedPromotion[1], body.folderRoot);
        reply(202, { phase: journal.phase, message: journal.message });
      }
    } catch (error) { reply(400, { error: error instanceof Error ? error.message : 'Could not keep the project.' }); }
    return true;
  }
  const promotion = req.url ? /^\/api\/research\/([0-9a-f-]{36})\/keep-as-project$/.exec(req.url.split('?')[0]) : null;
  if (promotion && (req.method === 'GET' || req.method === 'POST')) {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      if (req.method === 'GET') {
        const journal = await readQuickPromotion(promotion[1]);
        reply(200, journal ? { phase: journal.phase, message: journal.message, ...(journal.phase === 'done' ? { folder: journal.target } : {}) } : { phase: 'idle' });
      } else {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 16 * 1024) throw new Error('Request is too large.'); chunks.push(bytes); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { folderRoot?: string };
        const journal = await requestQuickPromotion(promotion[1], body.folderRoot);
        reply(202, { phase: journal.phase, message: journal.message });
      }
    } catch (error) { reply(400, { error: error instanceof Error ? error.message : 'Could not keep the project.' }); }
    return true;
  }
  const chatFolder = req.method === 'GET' && req.url ? /^\/api\/antigravity-chat-folder\/([0-9a-f-]{36})$/.exec(req.url) : null;
  if (chatFolder) {
    const wf = workflows.get(chatFolder[1]);
    if (!wf || wf.config.kind !== 'chat' || wf.primary.provider !== 'antigravity-cli' || wf.config.incognito) { res.writeHead(404); res.end(); return true; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ path: antigravityChatWorkspace(chatFolder[1]) }));
    return true;
  }
  // Durable live-cluster catalog. Cluster tabs are a browser-side working set,
  // while ~/.arco/clusters is authoritative; this read-only surface lets an
  // operator reopen an intact cluster whose localStorage tab was lost without
  // forking from an older snapshot.
  // docs/RESEARCH.md - the Research library on Home: list, the REOPEN
  // dialog's preview, LOCATE and FORGET. None of these touches a folder.
  const library = req.url ? /^\/api\/research\/library(?:\/([0-9a-f-]{36})\/(reopen|locate|forget))?(?:\?.*)?$/.exec(req.url) : null;
  if (library) {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const [, projectId, action] = library;
    try {
      if (!projectId && req.method === 'GET') { reply(200, { rows: await libraryRows(await liveResearchClusters()) }); return true; }
      if (action === 'reopen' && req.method === 'GET') {
        const preview = await reopenPreview(projectId, await liveResearchClusters(), async (p) => disabledClusterProvider([p]));
        reply(preview ? 200 : 404, preview ?? { error: 'unknown_project' }); return true;
      }
      if (action === 'forget' && req.method === 'POST') {
        if ((await liveResearchClusters()).has(projectId)) { reply(409, { error: 'project_open' }); return true; }
        reply((await forgetProject(projectId)) ? 200 : 404, { forgotten: true }); return true;
      }
      if (action === 'locate' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { folder?: unknown };
        const result = await locateProject(projectId, typeof body.folder === 'string' ? body.folder : '');
        reply(result.ok ? 200 : result.code === 'unknown_project' ? 404 : 400, result); return true;
      }
      reply(405, { error: 'method_not_allowed' });
    } catch (error) {
      reply(500, { error: 'library_failed', message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  // docs/RESEARCH.md - the operator's Reveal of a blind research project.
  const reveal = req.method === 'POST' && req.url ? /^\/api\/research\/([0-9a-f-]{36})\/reveal$/.exec(req.url) : null;
  if (reveal) {
    const ok = await revealResearch(reveal[1]).catch(() => false);
    res.writeHead(ok ? 200 : 409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { revealed: true } : { error: 'not_blind_or_unknown' }));
    return true;
  }
  // docs/RESEARCH.md "Round deadline" - the operator's +15 MIN.
  const extend = req.method === 'POST' && req.url ? /^\/api\/research\/([0-9a-f-]{36})\/rounds\/(-?\d+)\/extend$/.exec(req.url) : null;
  if (extend) {
    const result = await extendRound(extend[1], Number(extend[2])).catch(() => ({ ok: false as const, code: 'unknown_round' as const }));
    res.writeHead(result.ok ? 200 : result.code === 'unknown_round' ? 404 : 409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.ok ? { deadline: result.deadline } : { error: result.code }));
    return true;
  }
  // docs/RESEARCH.md "Retry" - the operator's RETRY on a failed or timed-out researcher.
  const retry = req.method === 'POST' && req.url ? /^\/api\/research\/([0-9a-f-]{36})\/rounds\/(\d+)\/retry\/([A-Za-z])$/.exec(req.url) : null;
  if (retry) {
    const result = await retryResearcher(retry[1], Number(retry[2]), retry[3]).catch((error) => ({ ok: false as const, code: 'busy' as const, message: error instanceof Error ? error.message : String(error) }));
    res.writeHead(result.ok ? 200 : result.code === 'not_research' || result.code === 'unknown_round' || result.code === 'unknown_researcher' ? 404 : 409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.ok ? { late: result.late, file: result.file } : { error: result.code, message: result.message }));
    return true;
  }
  // docs/RESEARCH.md - which summaries exist, for RESULTS.
  const summaries = req.method === 'GET' && req.url ? /^\/api\/research\/([0-9a-f-]{36})\/summaries$/.exec(req.url) : null;
  if (summaries) {
    const state = await loadResearch(summaries[1]).catch(() => null);
    if (!state) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unknown_research' })); return true; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...await researchSummaries(state), proposal: researchSendProposal(summaries[1]) ?? null }));
    return true;
  }
  // Operator-initiated reruns preserve the current panel for a new round or
  // return its settings for review before starting a separate project.
  const rerun = req.url ? /^\/api\/research\/([0-9a-f-]{36})\/(rerun-preview|rerun-round)$/.exec(req.url) : null;
  if (rerun) {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      const state = await loadResearch(rerun[1]);
      if (!state || state.closedAt) throw new Error('Research project is not open.');
      if (rerun[2] === 'rerun-preview' && req.method === 'GET') {
        await clusterStore.readCluster(state.clusterId);
        const config = workflows.get(state.directorWorkflowId)?.config ?? await readMeta(state.folder, state.directorWorkflowId).catch(() => null);
        const director = config && { provider: config.primaryProvider ?? 'claude', model: config.primaryModel, effort: config.primaryEffort, providerAccountRef: config.providerAccountRef };
        const researchers = await Promise.all(state.researchers.filter(r => !r.removedAt).map(async r => {
          const wf = workflows.get(r.workflowId)?.config ?? await readMeta(state.membersCwd, r.workflowId).catch(() => null);
          return { provider: r.provider, model: r.model, effort: r.effort, researchClaudeTransport: r.claudeTransport, providerAccountRef: wf?.providerAccountRef,
            webAccess: clusterStore.getMemberWebAccess(state.clusterId, r.workflowId),
            ...(wf?.webSearchMaxUses ? { webSearchMaxUses: wf.webSearchMaxUses } : {}),
            ...(typeof wf?.ollamaParams?.num_ctx === 'number' ? { contextSize: wf.ollamaParams.num_ctx } : {}) };
        }));
        reply(200, { name: state.name, brief: state.rounds[0]?.text ?? state.brief, blind: state.blind, sourceProject: state.sourceProject, director, researchers }); return true;
      }
      if (rerun[2] === 'rerun-round' && req.method === 'POST') {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 32768) throw new Error('Request is too large.'); chunks.push(bytes); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { brief?: unknown };
        const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
        if (brief.length > 20000) throw new Error('The brief is too long.');
        const result = await startRound(state.clusterId, state.directorWorkflowId, brief);
        if (!result.ok) { reply(400, { error: result.message }); return true; }
        let receiptError = false;
        try { await recordResearchExport(state, { kind: 'project' }, `rerun as round ${result.round}`); } catch { receiptError = true; }
        reply(200, { round: result.round, ...(receiptError ? { receiptError: 'The round started, but the export log could not be updated.' } : {}) }); return true;
      }
      reply(405, { error: 'Method not allowed.' });
    } catch (error) { reply(400, { error: error instanceof Error ? error.message : 'Could not rerun research.' }); }
    return true;
  }
  // Exports use a confirmation after the browser starts the requested action.
  const researchExport = req.method === 'POST' && req.url ? /^\/api\/research\/([0-9a-f-]{36})\/(preview-export|prepare-export|confirm-export)$/.exec(req.url) : null;
  if (researchExport) {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 16384) throw new Error('Request is too large.'); chunks.push(bytes); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { selection?: ResearchSelection; kind?: 'markdown' | 'file' | 'zip'; path?: string; token?: string };
      if (researchExport[2] === 'confirm-export') { await confirmResearchExport(researchExport[1], body.token ?? ''); reply(200, { recorded: true }); return true; }
      const state = await loadResearch(researchExport[1]);
      if (!state || !body.selection) throw new Error('Choose released research.');
      if (researchExport[2] === 'preview-export') reply(200, { files: await previewResearchExport(state, body.selection) });
      else reply(200, await prepareResearchExport(state, body.selection, body.kind!, body.path));
    } catch (error) { reply(400, { error: error instanceof Error ? error.message : 'Could not export research.' }); }
    return true;
  }
  // A result starts a separate project only after the operator chooses its folder.
  const researchStart = req.method === 'POST' && req.url ? /^\/api\/research\/([0-9a-f-]{36})\/(preview-start|prepare-start|confirm-start)$/.exec(req.url) : null;
  if (researchStart) {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 16384) throw new Error('Request is too large.'); chunks.push(bytes); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { selection?: ResearchSelection; parent?: string; name?: string; useExisting?: boolean; token?: string; workflowId?: string };
      if (researchStart[2] === 'confirm-start') {
        await confirmResearchStart(researchStart[1], body.token ?? '', body.workflowId ?? ''); reply(200, { recorded: true }); return true;
      }
      const state = await loadResearch(researchStart[1]);
      if (!state || !body.selection) throw new Error('Choose released research.');
      if (researchStart[2] === 'preview-start') reply(200, { files: await previewResearchStart(state, body.selection) });
      else reply(200, await prepareResearchStart(state, body.selection, body.parent ?? '', body.name ?? '', body.useExisting === true));
    } catch (error) { reply(400, { error: error instanceof Error ? error.message : 'Could not start the project.' }); }
    return true;
  }
  // Operator action: stage only released research for explicit destinations.
  const researchSend = req.method === 'POST' && req.url ? /^\/api\/research\/([0-9a-f-]{36})\/(send-to-project|confirm-composer|dismiss-send-proposal)$/.exec(req.url) : null;
  if (researchSend) {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 16384) throw new Error('Request is too large.'); chunks.push(bytes); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { selection?: ResearchSelection; destination?: string; folderCopy?: boolean; planId?: string; composerWorkflowId?: string; continueChat?: boolean; token?: string };
      if (researchSend[2] === 'dismiss-send-proposal') { clearResearchSendProposal(researchSend[1]); send(200, { dismissed: true }); return true; }
      if (researchSend[2] === 'confirm-composer') {
        if (typeof body.token !== 'string') { send(400, { error: 'Missing attachment confirmation.' }); return true; }
        await confirmResearchComposer(researchSend[1], body.token); send(200, { recorded: true }); return true;
      }
      if (!body.selection || (body.folderCopy !== true && !body.planId && typeof body.composerWorkflowId !== 'string')) { send(400, { error: 'Choose research and at least one destination.' }); return true; }
      const state = await loadResearch(researchSend[1]);
      if (!state) { send(404, { error: 'Research project not found.' }); return true; }
      const result: Record<string, unknown> = {};
      if (body.folderCopy) {
        try { result.folder = await sendResearchToFolder(state, body.selection, body.destination ?? ''); }
        catch (error) { result.folder = { written: [], error: error instanceof Error ? error.message : 'Folder copy failed.' }; }
      }
      if (body.planId) {
        try { result.plan = await sendResearchToPlan(state, body.selection, body.destination ?? '', body.planId); }
        catch (error) { result.plan = { written: [], error: error instanceof Error ? error.message : 'Plan reference failed.' }; }
      }
      if (body.composerWorkflowId) {
        try { result.composer = await stageResearchForComposer(state, body.selection, body.composerWorkflowId, body.continueChat === true ? 'continue' : undefined); }
        catch (error) { result.composer = { attachments: [], error: error instanceof Error ? error.message : 'Attachment failed.' }; }
      }
      send(200, result);
    } catch (error) { send(400, { error: error instanceof Error ? error.message : 'Could not send research.' }); }
    return true;
  }
  // docs/RESEARCH.md - what REMOVE shows: files one researcher saved but never sent.
  const removing = req.method === 'GET' && req.url ? /^\/api\/research\/([0-9a-f-]{36})\/researchers\/([A-Za-z])\/unsent$/.exec(req.url) : null;
  if (removing) {
    const state = await loadResearch(removing[1]).catch(() => null);
    res.writeHead(state ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state ? { unsent: await unsentFiles(state, [removing[2].toUpperCase()]) } : { error: 'unknown_research' }));
    return true;
  }
  // docs/RESEARCH.md - closing a research tab: what the close dialog shows,
  // then the cleanup itself.
  const closing = req.url ? /^\/api\/research\/([0-9a-f-]{36})\/(close-preview|close)$/.exec(req.url) : null;
  if (closing && ((closing[2] === 'close-preview' && req.method === 'GET') || (closing[2] === 'close' && req.method === 'POST'))) {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      if (closing[2] === 'close-preview') {
        const state = await loadResearch(closing[1]);
        if (!state) { send(404, { error: 'unknown_research' }); return true; }
        send(200, { unsent: await unsentFiles(state) });
        return true;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { moveUnsent?: unknown } : {};
      const result = await closeResearch(closing[1], { moveUnsent: body.moveUnsent === true, isBusy: isResearchMemberBusy });
      send(result.ok ? 200 : result.error === 'unknown_research' ? 404 : 409, result);
    } catch (error) {
      send(500, { error: 'close_failed', message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (req.url === '/api/clusters' && req.method === 'GET') {
    try {
      // `open`: in the server-authoritative workspace (some browser has the
      // tab). `cwdExists`: false for clusters whose project folder is gone —
      // mostly /tmp/arco-smoke-* leftovers — so the creator can flag them
      // and offer a bulk clean-up instead of listing them as reopenable.
      const clusters = await Promise.all((await clusterStore.loadAllClustersFromDisk())
        .map(async (cluster) => ({
          clusterId: cluster.clusterId,
          name: cluster.name,
          cwd: cluster.cwd,
          memberCount: cluster.members.length,
          createdAt: cluster.createdAt,
          open: isClusterOpen(cluster.clusterId),
          cwdExists: await fs.stat(cluster.cwd).then((st) => st.isDirectory(), () => false),
        })));
      clusters.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ clusters }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  // docs/PROTOCOL_CLUSTER.md - REST shim for cluster lifecycle. No
  // WS surface, no UI yet — operator wires Native tabs to a cluster via
  // curl, then drives turns through the existing chat composer per tab.
  // Phase 2 replaces this with proper WS messages.
  if (req.url === '/api/clusters' && req.method === 'POST') {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
        cwd?: string;
        memberWorkflowIds?: unknown;
      };
      const cwd = typeof body.cwd === 'string' ? body.cwd : '';
      const memberIds = Array.isArray(body.memberWorkflowIds)
        ? body.memberWorkflowIds.filter((m): m is string => typeof m === 'string')
        : [];
      if (!cwd || memberIds.length < 2) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'cwd and memberWorkflowIds (≥2) are required' }));
        return true;
      }
      // docs/PROTOCOL_CLUSTER.md - Native-transport fence. Phase 1
      // substrate ships peer tools only in the Native worker; CLI / Codex
      // parity lands in Phase 3+. Reject early so the operator gets a clear
      // error instead of a cluster that quietly never works for non-Native
      // members. Skipped when the workflow lookup misses entirely (CLI
      // operator may legitimately POST against workflows the server hasn't
      // hydrated yet — but at least one of them being unhydrated is also
      // suspect, so we still surface the code).
      const existingRefusal = existingClusterMemberRefusal(memberIds);
      if (existingRefusal) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: existingRefusal }));
        return true;
      }
      const fence = await deps.assertAllMembersClaudeOrCodex(memberIds);
      if (fence) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: fence }));
        return true;
      }
      const memberProviders = memberIds.map(memberProvider);
      const disabled = await disabledClusterProvider(memberProviders);
      if (disabled) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: disabled }));
        return true;
      }
      const capacity = await localCapacityRefusal(memberProviders, memberProviders);
      if (capacity) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'local_capacity', message: capacity.replace(/^local_capacity: /, '') }));
        return true;
      }
      // Hard fence (plan §6.2): refuse if any candidate member is itself
      // a cluster. Phase 1 has no nested-cluster shape — every workflow
      // is "primary" — but defend the invariant for forward-compat.
      const cluster = await clusterStore.createCluster({ cwd, memberWorkflowIds: memberIds });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ clusterId: cluster.clusterId, members: cluster.members, cwd: cluster.cwd, createdAt: cluster.createdAt }));
    } catch (err) {
      const code = (err as { code?: string })?.code ?? 'create_failed';
      const status = code === 'invalid_cwd' || code === 'too_few_members' || code === 'member_already_in_cluster' ? 400 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: code, message: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  // docs/PROTOCOL_CLUSTER.md - peer-ops REST surface consumed by the
  // CLI MCP stdio child (`server/src/mcp/clusterMcpServer.ts`). One endpoint
  // per peer tool; each delegates to `clusterPeerOps` so Native + CLI
  // members fire identical WS events. Caller identity is the `workflowId`
  // in the body (send / read) or query (list) — trusted because the MCP
  // child has the workflowId baked into its argv at spawn time and the
  // loopback HTTP surface has no public attack vector. Any future remote-
  // access mode must add authentication here.
  //
  // URL shape: `/api/clusters/:id/peer/(list|send|read)`. Comes before the
  // bare `/api/clusters/:id` GET/DELETE handlers so the prefix match
  // doesn't swallow the `:id/peer/...` segments as a clusterId.
  if (req.url?.startsWith('/api/clusters/') && req.url.includes('/peer/')) {
    const path = req.url.split(/[?#]/)[0];
    const segments = path.split('/'); // ['', 'api', 'clusters', '<id>', 'peer', '<op>']
    if (segments.length === 6 && segments[1] === 'api' && segments[2] === 'clusters' && segments[4] === 'peer') {
      const clusterId = segments[3];
      const op = segments[5];
      const cluster = await clusterStore.readCluster(clusterId).catch(() => null);
      if (!cluster) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown_cluster' }));
        return true;
      }
      const taskOps = new Set([
        'task-list',
        'task-show',
        'task-create',
        'task-claim',
        'task-heartbeat',
        'task-comment',
        'task-link',
        'task-unlink',
        'task-block',
        'task-complete',
        'task-update',
      ]);
      if (taskOps.has(op) && !clusterStore.isTaskBoardEnabledForState(cluster)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'board_detached', message: 'no task board is enabled for this cluster.' }));
        return true;
      }
      const makeCtx = (workflowId: string): clusterPeerOps.PeerOpsContext => ({
        workflowId,
        clusterId,
        broadcastSender: (msg) => broadcastWorkflow(workflowId, msg),
        broadcastRecipient: (toWfId, msg) => broadcastWorkflow(toWfId, msg),
      });
      try {
        if (op === 'list' && req.method === 'GET') {
          const url = new URL(req.url, `http://localhost:${PORT}`);
          const workflowId = url.searchParams.get('workflowId') || '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const rows = await clusterPeerOps.peerList(makeCtx(workflowId));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(rows));
          return true;
        }
        if (op === 'send' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            from?: string; to?: string; content?: string; confirm?: boolean; taskId?: string; artifactPaths?: unknown;
          };
          const from = typeof body.from === 'string' ? body.from : '';
          const to = typeof body.to === 'string' ? body.to : '';
          const content = typeof body.content === 'string' ? body.content : '';
          if (!from || !cluster.members.includes(from)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'from must be a cluster member' }));
            return true;
          }
          if (!to || !content) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'to and content are required' }));
            return true;
          }
          if (body.artifactPaths !== undefined && (!Array.isArray(body.artifactPaths) || body.artifactPaths.length > 8
            || body.artifactPaths.some(path => typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')))) {
            res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid artifact paths' })); return true;
          }
          const result = await clusterPeerOps.peerSend(makeCtx(from), { to, content, confirm: body.confirm === true, ...(typeof body.taskId === 'string' ? { taskId: body.taskId } : {}), ...(Array.isArray(body.artifactPaths) ? { artifactPaths: body.artifactPaths as string[] } : {}) });
          if (!result.ok) {
            // 400 for policy rejections — the MCP child translates these
            // into `isError: true` MCP results so the model sees a tool
            // error rather than a silent success.
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message, count: result.count, cap: result.cap }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ msgId: result.msgId, to: result.to, deliveredImmediately: result.deliveredImmediately, ...(result.heldForRound !== undefined ? { heldForRound: Math.max(1, result.heldForRound), note: researchHeldNote(result.heldForRound) } : {}), ...(result.recipientContext ? { recipientContext: result.recipientContext } : {}), ...(result.guard ? { guard: result.guard } : {}) }));
          return true;
        }
        if (op === 'research_send_to_project' && req.method === 'POST') {
          const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { from?: string; selection?: ResearchSelection };
          try {
            await proposeResearchSend(clusterId, body.from ?? '', body.selection as ResearchSelection);
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ proposed: true, message: 'The operator chooses a destination and sends it from RESULTS.' }));
          } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Could not propose sending results.' })); }
          return true;
        }
        if (op === 'research_round' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as { from?: string; text?: string };
          const from = typeof body.from === 'string' ? body.from : '';
          if (!from || !cluster.members.includes(from)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'from must be a cluster member' }));
            return true;
          }
          const result = await startRound(clusterId, from, typeof body.text === 'string' ? body.text : '');
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(result.ok ? formatResearchRoundResult(result) : JSON.stringify({ error: result.code, message: result.message }));
          return true;
        }
        if (op === 'read' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string;
            onlyFrom?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          if (body.onlyFrom !== undefined && (typeof body.onlyFrom !== 'string' || !cluster.members.includes(body.onlyFrom))) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'onlyFrom must be a cluster member' }));
            return true;
          }
          const drained = await clusterPeerOps.peerRead(makeCtx(workflowId), body.onlyFrom ? { onlyFrom: body.onlyFrom } : undefined);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(drained));
          return true;
        }
        // Peer tool `cluster_plan_read` — return the full canonical plan
        // body. Body shape: `{ workflowId }`. Read-only: the injected
        // per-turn copy may be an outline for oversized plans, so members
        // need a pull channel to the full body.
        if (op === 'plan-read' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const reqBody = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string;
          };
          const workflowId = typeof reqBody.workflowId === 'string' ? reqBody.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerPlanRead(makeCtx(workflowId));
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            planId: result.planId,
            revision: result.revision,
            title: result.title,
            body: result.body,
            updatedAt: result.updatedAt,
            byteLength: result.byteLength,
          }));
          return true;
        }
        // Peer tool `cluster_plan_tick` — toggle a single checkbox in the
        // shared cluster plan. Body shape: `{ workflowId, lineIndex }` or
        // `{ workflowId, taskText }`. Mirrors the Native peer-tool surface
        // exactly so the CLI Claude MCP child (which posts here) sees the
        // same error codes the Native dispatcher returns.
        if (op === 'plan-tick' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string; lineIndex?: number; taskText?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const matcher: clusterPeerOps.PeerPlanTickMatcher = (typeof body.lineIndex === 'number')
            ? { lineIndex: body.lineIndex }
            : (typeof body.taskText === 'string')
              ? { taskText: body.taskText }
              : ({} as clusterPeerOps.PeerPlanTickMatcher);
          const result = await clusterPeerOps.peerPlanTick(
            makeCtx(workflowId),
            matcher,
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message, matches: result.matches }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            toggledLine: result.toggledLine,
            before: result.before,
            after: result.after,
          }));
          return true;
        }
        // `cluster_plan_write`. Model-driven writes are
        // additive by default; destructive replacement stays operator-only
        // through the PLAN tab.
        // Body shape: `{ workflowId, body }`. Same HTTP shape the MCP
        // child posts when proxying the model's tool call. Convention:
        // only the director calls this (enforced via role preset, not
        // server-side).
        if (op === 'plan-write' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string; body?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerPlanWrite(
            makeCtx(workflowId),
            typeof body.body === 'string' ? body.body : '',
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: result.code,
              message: result.message,
              limit: result.limit,
              actual: result.actual,
              removed: result.removed,
              statusChanged: result.statusChanged,
            }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ bodyLength: result.bodyLength, updatedAt: result.updatedAt }));
          return true;
        }
        // §D3 task-board peer-ops. `cluster_task_list` reads the cwd's ledger;
        // `cluster_task_claim` / `cluster_task_update` mutate it and broadcast a
        // fresh task_ledger_snapshot cluster-wide. Same HTTP shape the MCP child
        // posts; mutations carry the caller's workflowId so peerTaskClaim can
        // stamp assignee. done stays operator-gated (peerTaskUpdate rejects it).
        if (op === 'task-list' && req.method === 'GET') {
          const url = new URL(req.url, `http://localhost:${PORT}`);
          const workflowId = url.searchParams.get('workflowId') || '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerTaskList(makeCtx(workflowId));
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          // Compact, always-valid board view (drops done/archived, strips fat
          // notes, bounds size) — the raw dump blew the CLI/Codex worker's
          // tool-output cap. Native uses the same formatter. The operator UI
          // reads task_ledger_snapshot WS broadcasts, not this endpoint.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(formatBoardForModel(result.tasks));
          return true;
        }
        if (op === 'task-show' && req.method === 'GET') {
          const url = new URL(req.url, `http://localhost:${PORT}`);
          const workflowId = url.searchParams.get('workflowId') || '';
          const id = url.searchParams.get('id') || '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerTaskShow(makeCtx(workflowId), { id });
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.details));
          return true;
        }
        if (op === 'task-create' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string;
            title?: string;
            body?: string;
            notes?: string;
            assignee?: string;
            priority?: number;
            parentIds?: unknown;
            links?: unknown;
            reviewRequired?: boolean;
            goalMode?: boolean;
            goalMaxTurns?: number;
            release?: string;
            status?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerTaskCreate(
            makeCtx(workflowId),
            {
              title: typeof body.title === 'string' ? body.title : '',
              ...(typeof body.body === 'string' ? { body: body.body } : {}),
              ...(typeof body.notes === 'string' ? { notes: body.notes } : {}),
              ...(typeof body.assignee === 'string' ? { assignee: body.assignee } : {}),
              ...(typeof body.priority === 'number' ? { priority: body.priority } : {}),
              ...(Array.isArray(body.parentIds) ? { parentIds: body.parentIds.filter((id): id is string => typeof id === 'string') } : {}),
              ...(Array.isArray(body.links) ? { links: body.links as TaskLink[] } : {}),
              ...(typeof body.reviewRequired === 'boolean' ? { reviewRequired: body.reviewRequired } : {}),
              ...(typeof body.goalMode === 'boolean' ? { goalMode: body.goalMode } : {}),
              ...(typeof body.goalMaxTurns === 'number' ? { goalMaxTurns: body.goalMaxTurns } : {}),
              ...(typeof body.release === 'string' ? { release: body.release } : {}),
              ...(typeof body.status === 'string' ? { status: body.status as LedgerTaskStatus } : {}),
            },
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.task));
          return true;
        }
        if (op === 'task-claim' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string; id?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerTaskClaim(
            makeCtx(workflowId),
            { id: typeof body.id === 'string' ? body.id : '' },
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.task));
          return true;
        }
        if (op === 'task-heartbeat' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string; id?: string; note?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerTaskHeartbeat(
            makeCtx(workflowId),
            {
              id: typeof body.id === 'string' ? body.id : '',
              ...(typeof body.note === 'string' ? { note: body.note } : {}),
            },
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ run: result.run, ...(result.comment ? { comment: result.comment } : {}) }));
          return true;
        }
        if (op === 'task-comment' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string; id?: string; body?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerTaskComment(
            makeCtx(workflowId),
            { id: typeof body.id === 'string' ? body.id : '', body: typeof body.body === 'string' ? body.body : '' },
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.comment));
          return true;
        }
        if ((op === 'task-link' || op === 'task-unlink') && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string; parentId?: string; childId?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const fn = op === 'task-link' ? clusterPeerOps.peerTaskLink : clusterPeerOps.peerTaskUnlink;
          const result = await fn(
            makeCtx(workflowId),
            {
              parentId: typeof body.parentId === 'string' ? body.parentId : '',
              childId: typeof body.childId === 'string' ? body.childId : '',
            },
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.task));
          return true;
        }
        if (op === 'task-block' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string; id?: string; reason?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerTaskBlock(
            makeCtx(workflowId),
            { id: typeof body.id === 'string' ? body.id : '', reason: typeof body.reason === 'string' ? body.reason : '' },
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.task));
          return true;
        }
        if (op === 'task-complete' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string; id?: string; summary?: string;
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerTaskComplete(
            makeCtx(workflowId),
            { id: typeof body.id === 'string' ? body.id : '', summary: typeof body.summary === 'string' ? body.summary : '' },
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.task));
          return true;
        }
        if (op === 'task-update' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            workflowId?: string; id?: string; status?: string; notes?: string; release?: string;
            signoff?: { state?: string; summary?: string } | null; completePlan?: { planId: string; itemId: string; revision: string };
          };
          const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
          if (!workflowId || !cluster.members.includes(workflowId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'workflowId must be a cluster member' }));
            return true;
          }
          const result = await clusterPeerOps.peerTaskUpdate(
            makeCtx(workflowId),
            {
              id: typeof body.id === 'string' ? body.id : '',
              ...(typeof body.status === 'string' ? { status: body.status as LedgerTaskStatus } : {}),
              ...(typeof body.notes === 'string' ? { notes: body.notes } : {}),
              ...(typeof body.release === 'string' ? { release: body.release } : {}),
              // §D3 — advisory sign-off; peerTaskUpdate validates + stamps author.
              ...(body.signoff !== undefined ? { signoff: body.signoff } : {}),
              ...(body.completePlan !== undefined ? { completePlan: body.completePlan } : {}),
            },
            (msg) => broadcastCluster(clusterId, msg),
          );
          if (!result.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.code, message: result.message }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.task));
          return true;
        }
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'method_not_allowed', op, method: req.method }));
        return true;
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'peer_op_failed', message: err instanceof Error ? err.message : String(err) }));
        return true;
      }
    }
  }

  // Mailbox modal endpoints — operator-only peek + cancel surface for the
  // Mailbox tab's expand → modal flow.
  //   GET    /api/clusters/:id/mailbox/:wfid          → peek (no drain)
  //   DELETE /api/clusters/:id/mailbox/:wfid/:msgId   → discard pending msg
  //   PUT    /api/clusters/:id/mailbox/:wfid/:msgId   → edit pending msg text
  // Peek is destructive-free (drain is the model's path); discard removes the
  // file and pushes a fresh cluster_state so the depth indicator follows.
  if (req.url?.startsWith('/api/clusters/') && req.url.includes('/mailbox')) {
    const path = req.url.split(/[?#]/)[0];
    const segs = path.split('/'); // ['', 'api', 'clusters', '<id>', 'mailbox', '<wfid>', '<msgId>?']
    if (segs.length >= 6 && segs[1] === 'api' && segs[2] === 'clusters' && segs[4] === 'mailbox') {
      const clusterId = segs[3];
      const wfid = segs[5];
      const cluster = await clusterStore.readCluster(clusterId).catch(() => null);
      if (!cluster || !cluster.members.includes(wfid)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown_cluster_or_member' }));
        return true;
      }
      try {
        if (segs.length === 6 && req.method === 'GET') {
          const pending = await clusterMailbox.peek(wfid);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          const contexts = new Map<string, Awaited<ReturnType<typeof recipientContext>> | undefined>();
          // One streaming lookup per sender, sequentially, bounds active readers.
          for (const sender of new Set(pending.map((m) => m.fromWorkflowId))) {
            contexts.set(sender, await recipientContext(clusterId, sender, wfid).catch(() => undefined));
          }
          const enriched = pending.map((m) => ({ ...m, recipientContext: contexts.get(m.fromWorkflowId) }));
          res.end(JSON.stringify(enriched));
          return true;
        }
        if (segs.length === 7 && req.method === 'PUT') {
          // EDIT in the mailbox modal: rewrite one pending message in place,
          // under the mailbox lock. A delivered message is refused.
          const msgId = segs[6];
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > clusterMailbox.OPERATOR_EDIT_MAX_BYTES * 2) throw new Error('Request is too large.'); chunks.push(bytes); }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { content?: unknown };
          if (typeof body.content !== 'string' || !body.content.trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'empty_message', message: 'The message cannot be empty.' }));
            return true;
          }
          const result = await clusterMailbox.editPending(wfid, msgId, body.content);
          if (result === 'delivered') {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'already_delivered', message: 'Not saved: the message was already read or cancelled.' }));
            return true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, msgId }));
          return true;
        }
        if (segs.length === 7 && req.method === 'DELETE') {
          const msgId = segs[6];
          const removed = await clusterMailbox.discard(wfid, msgId);
          if (!removed) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unknown_message' }));
            return true;
          }
          // Re-emit cluster_state so the depth chip + Mailbox modal observers
          // drop the cancelled message without a refetch.
          void notifyClusterStateForWorkflow(wfid);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, msgId }));
          return true;
        }
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'method_not_allowed', method: req.method }));
        return true;
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'mailbox_op_failed', message: err instanceof Error ? err.message : String(err) }));
        return true;
      }
    }
  }

  // docs/PROVIDERS.md - per-tab sandbox endpoints. Three ops
  // live here:
  //   POST /api/workflows/:wfId/sandbox/clear       — truncate chunks table
  //   GET  /api/workflows/:wfId/sandbox/stats       — { chunkCount, totalBytes, dbPath, recent[] }
  //   POST /api/workflows/:wfId/sandbox/_test_insert — dev-only synthetic insert (smoke harness)
  // The clear op fires `sandbox_db_cleared` on the workflow channel so the
  // Files-tab sub-section drops to zero without a refetch.
  if (req.url?.startsWith('/api/workflows/') && req.url.includes('/sandbox')) {
    const path = req.url.split(/[?#]/)[0];
    const segs = path.split('/'); // ['', 'api', 'workflows', '<wfid>', 'sandbox', '<op>']
    if (segs.length === 6 && segs[1] === 'api' && segs[2] === 'workflows' && segs[4] === 'sandbox') {
      const wfid = segs[3];
      const op = segs[5];
      const wf = workflows.get(wfid);
      const cwd = wf?.config.workingDirectory ?? workflowCwds.get(wfid) ?? null;
      if (!cwd) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown_workflow' }));
        return true;
      }
      try {
        if (op === 'clear' && req.method === 'POST') {
          const store = getSandboxStore(cwd, wfid);
          store.clear();
          broadcastWorkflow(wfid, { type: 'sandbox_db_cleared', workflowId: wfid });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, dbPath: getSandboxDbPath(cwd, wfid) }));
          return true;
        }
        if (op === 'stats' && req.method === 'GET') {
          const store = getSandboxStore(cwd, wfid);
          const stats = store.stats();
          const recent = store.recentChunks(20);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...stats, recent }));
          return true;
        }
        if (op === '_test_insert' && req.method === 'POST') {
          // Test-only escape hatch used by `scripts/smoke/phase-e.ts` to
          // exercise the clear / stats / teardown paths without paying for
          // a real Anthropic round-trip. Gated by NODE_ENV so production
          // builds reject the route outright.
          if (process.env.NODE_ENV === 'production') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not_found' }));
            return true;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
            language?: string; content?: string;
          };
          const language = typeof body.language === 'string' ? body.language : 'shell';
          const content = typeof body.content === 'string' ? body.content : '';
          if (!content) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'content required' }));
            return true;
          }
          const store = getSandboxStore(cwd, wfid);
          const info = store.insertChunk(language, content);
          broadcastWorkflow(wfid, {
            type: 'sandbox_chunk_added',
            workflowId: wfid,
            chunkId: info.chunkId,
            byteLen: info.byteLen,
            language,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(info));
          return true;
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'sandbox_op_failed', message: err instanceof Error ? err.message : String(err) }));
        return true;
      }
    }
  }

  if (req.url?.startsWith('/api/clusters/') && req.method === 'GET') {
    const clusterId = req.url.slice('/api/clusters/'.length).split(/[?#]/)[0];
    if (!clusterId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'clusterId required' }));
      return true;
    }
    const state = await clusterStore.readCluster(clusterId).catch(() => null);
    if (!state) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return true;
    }
    const mailboxDepth: Record<string, number> = {};
    for (const wfid of state.members) {
      mailboxDepth[wfid] = await clusterMailbox.depthFor(wfid).catch(() => 0);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...state, mailboxDepth }));
    return true;
  }

  if (req.url?.startsWith('/api/clusters/') && req.method === 'DELETE') {
    const clusterId = req.url.slice('/api/clusters/'.length).split(/[?#]/)[0];
    if (!clusterId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'clusterId required' }));
      return true;
    }
    try {
      // Reuse the WS-side handler so mcp-config cleanup + cluster_deleted
      // broadcast fire identically regardless of which surface initiated
      // the delete. REST and WS converge on `handleClusterDelete`.
      await deps.handleClusterDelete(clusterId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: clusterId }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  // docs/PROVIDERS.md - operator clicked "Re-index now" in the
  // CONFIG-tab CodebaseMemorySection. One-shot spawn of the operator-
  // installed `codebase-memory-mcp` binary with `--skip-config` so it
  // doesn't auto-edit other agent configs. Returns 503 (not 500) when the
  // binary isn't on PATH so the client toast can point at OPERATIONS.md.
  // Phase F ships UX wiring only; the long-lived MCP attachment at CLI
  // spawn time lands in a follow-up after Cluster 3's `mcpConfigWriter`.
  const reindexMatch = req.url?.match(/^\/api\/workflows\/([^/]+)\/codebase-memory\/reindex(?:\?|$)/);
  if (reindexMatch && req.method === 'POST') {
    const workflowId = decodeURIComponent(reindexMatch[1]);
    const wf = workflows.get(workflowId);
    if (!wf) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown_workflow' }));
      return true;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as { indexPath?: string };
      const indexPath = (typeof body.indexPath === 'string' && body.indexPath.trim())
        ? body.indexPath.trim()
        : (wf.config.codebaseMemory?.indexPath || wf.config.workingDirectory);
      if (!indexPath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'index_path_required' }));
        return true;
      }
      // One-shot spawn. The binary auto-edits agent config files unless
      // --skip-config is passed — that's a hard invariant for Arco.
      const child = spawn('codebase-memory-mcp', ['reindex', '--path', indexPath, '--skip-config'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
      child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
      const exit = await new Promise<{ code: number | null; err?: NodeJS.ErrnoException }>((resolve) => {
        child.on('error', (err) => resolve({ code: null, err: err as NodeJS.ErrnoException }));
        child.on('close', (code) => resolve({ code }));
      });
      if (exit.err && (exit.err.code === 'ENOENT' || exit.err.code === 'EACCES')) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'binary_not_installed', message: 'codebase-memory-mcp not installed — see docs/OPERATIONS.md' }));
        return true;
      }
      if (exit.code !== 0) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'reindex_failed', code: exit.code, stderr: stderr.slice(0, 2000) }));
        return true;
      }
      // Best-effort: the binary's stdout may carry a JSON summary with
      // fileCount. Treat parse failures as "no data" — the timestamp alone
      // is still useful.
      let fileCount: number | undefined;
      try {
        const trimmed = stdout.trim();
        if (trimmed.startsWith('{')) {
          const parsed = JSON.parse(trimmed) as { fileCount?: number };
          if (typeof parsed.fileCount === 'number') fileCount = parsed.fileCount;
        }
      } catch { /* not JSON — ignore */ }
      const now = Date.now();
      const prev = wf.config.codebaseMemory ?? { attached: false };
      wf.config.codebaseMemory = {
        attached: prev.attached === true,
        indexPath,
        lastIndexedAt: now,
        fileCount,
      };
      const cwd = wf.config.workingDirectory;
      if (cwd) {
        try {
          const codebaseMemory = { ...wf.config.codebaseMemory };
          await updateMeta(cwd, workflowId, (meta) => {
            meta.codebaseMemory = codebaseMemory;
            meta.lastActiveAt = now;
          });
        } catch (err) {
          console.error(`[arco] [${workflowId.slice(0, 8)}] reindex meta write failed:`, err);
        }
      }
      broadcastWorkflow(workflowId, {
        type: 'codebase_memory_state',
        workflowId,
        attached: wf.config.codebaseMemory.attached,
        indexPath,
        lastIndexedAt: now,
        fileCount,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ indexPath, lastIndexedAt: now, fileCount }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal', message: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  return false;
}
