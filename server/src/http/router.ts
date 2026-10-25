import { tryHandleDeepSeekRoutes } from './deepseekRoutes.js';
import { tryHandleVoiceRoutes } from './voiceRoutes.js';
import type {
ArchonSettings,Capabilities,
ClusterPresetMember,ProviderName
} from '@archon/shared';
import { type LlamacppModelDef } from '@archon/shared';
import { spawn } from 'child_process';
import { chmodSync,writeFileSync } from 'fs';
import { mkdir,readdir,readFile,writeFile } from 'fs/promises';
import { IncomingMessage,ServerResponse } from 'http';
import { homedir,tmpdir } from 'os';
import { basename,extname,join,resolve,sep } from 'path';
import { unloadLocalModels } from '../localModels.js';
import { getAuthStatus,triggerAuthLogin } from '../auth.js';
import { cliSnapshotDir,runCliUpdate,refreshRuntimeVersions,type CliProvider } from '../capabilities.js';
import { readCatalog,writeCatalog } from '../catalog.js';
import {
deletePreset as deleteClusterPreset,
listPresets as listClusterPresets,
PresetValidationError,
savePreset as saveClusterPreset,
} from '../clusterPresets.js';
import { getCodexUsage,launchCodexUsageLogin } from '../codexUsage.js';
import { getCursorUsage } from '../cursorUsage.js';
import { getZaiUsage } from '../zai.js';
import {
deleteTemplate,
listTemplates,
saveTemplate,
TemplateValidationError,
} from '../templates/store.js';
import { checkoutBranch,getGitStatus } from '../git.js';
import {
deleteOverride as deleteHandoffOverride,
DEFAULT_TEMPLATES as HANDOFF_DEFAULT_TEMPLATES,
loadEffectivePrompt as loadHandoffPrompt,
readOverride as readHandoffOverride,
validateOverride as validateHandoffOverride,
writeOverride as writeHandoffOverride,
type HandoffPromptMode,
type HandoffPromptScope,
} from '../handoffPrompts.js';
import type { LlamacppCatalog } from '../llamacppCatalog.js';
import { readCatalog as readLlamacppCatalog,writeCatalog as writeLlamacppCatalog } from '../llamacppCatalog.js';
import { probeOnce as probePreviewPort } from '../previewAutoDetect.js';
import { tryHandlePreviewRequest } from '../previewProxy.js';
import { clearTokens as clearClaudeNativeTokens,loadTokens as loadClaudeNativeTokens } from '../providers/claude-native/auth.js';
import { getCatalog as getClaudeNativeCatalog } from '../providers/claude-native/catalog.js';
import { CLAUDE_CLI_USER_AGENT } from '../providers/claude-native/wireFingerprint.js';
import {
completeBootstrap as claudeNativeCompleteBootstrap,
startBootstrap as claudeNativeStartBootstrap,
ensureLiveTokens as ensureClaudeNativeTokens,
} from '../providers/claude-native/oauth.js';
import { getCodexCatalog } from '../providers/codex-appserver/catalog.js';
import { resolveProviderAccount, ensureCodexAccountHome } from '../providerAccounts.js';
import { getCatalog as getGeminiNativeCatalog } from '../providers/gemini-native/catalog.js';
import { getCursorCatalog } from '../providers/cursor/catalog.js';
import { clearZaiApiKey, saveZaiApiKey, zaiApiKeyStatus } from '../providerSecrets.js';
import { probeLlamacppLive } from '../providers/llamacpp.js';
import { llamacppManager } from '../providers/llamacppManager.js';
import { probeOllamaLive, aggregateOllamaPs, unloadOllamaModel } from '../providers/ollama.js';
import { resolveWithinCwd } from '../providers/ollamaTools.js';
import { computeVramReport, computeOllamaFit } from '../providers/ollamaVram.js';
import {
markAvailable as quotaMarkAvailable,
markThrottled as quotaMarkThrottled,
wireSnapshot as quotaWireSnapshot
} from '../quota.js';
import {
broadcastWorkflow,
send
} from '../server/broadcast.js';
import {
compareDirectoryNames,
PORT,
PROJECT_ROOT,
UPLOAD_IMAGE_EXT,
UPLOADS_DIR
} from '../server/constants.js';
import { queueModelImage } from '../providers/attachments.js';
import {
sessions,
workflows
} from '../server/state.js';
import {
patchSettings,
readSettings
} from '../settings.js';
import {
deleteSkill,
isValidSlug,
listSkills,
readSkillBody,
writeSkill,
type SkillScope
} from '../skills.js';
import { discoverToolbox } from '../toolbox.js';
import { auditSkillContent } from '../skillAudit.js';
import { getUsage } from '../usage.js';
import { artifactsDir } from '../workers/limits.js';
import { listAllListeningProcesses } from '../workers/procListeningAll.js';
import {
flushAll as flushAllWorkflowEvents
} from '../workflowStore.js';
import { readFileForExplorer } from './fileRead.js';
import { listBrowserDirectory, resolveBrowserRead } from './readConfinement.js';
import { confinedPath, safeDirectory } from '../fileAccessPolicy.js';
import { tryHandleClusterRoutes } from './clusterRoutes.js';
import { tryHandleClusterSnapshotRoutes } from './clusterSnapshotRoutes.js';
import { tryHandleDiffRoutes } from './diffRoutes.js';
import { tryHandleGitDiffRoutes } from './gitDiffRoutes.js';
import { tryHandleGitWorktreeRoutes } from './gitWorktreeRoutes.js';
import { tryHandleGitBakeoffRoutes } from './gitBakeoffRoutes.js';
import { tryHandleGitCompareRoutes } from './gitCompareRoutes.js';
import { tryHandleGitOpRoutes } from './gitOpRoutes.js';
import { tryHandleFileWriteRoutes } from './fileWriteRoutes.js';
import { tryHandleGithubRoutes } from './githubRoutes.js';
import { tryHandleSearchRoutes } from './searchRoutes.js';
import { tryHandleRecallRoutes } from './recallRoutes.js';
import { tryHandleUsageStatsRoutes } from './usageStatsRoutes.js';
import { tryHandleEndpointDiscoveryRoutes } from './endpointDiscoveryRoutes.js';
import { tryHandleDiagnosticsRoutes } from './diagnosticsRoutes.js';
import { tryHandleProjectTrustRoutes } from './projectTrustRoutes.js';
import { tryHandleServicesRoutes } from './servicesRoutes.js';
import { tryHandleCookbookRoutes } from './cookbookRoutes.js';
import { tryHandleMediaOpsRoutes } from './mediaOpsRoutes.js';
import { tryHandleImageWriteRoutes } from './imageWriteRoutes.js';
import { tryHandleWorkflowDataRoutes } from './workflowDataRoutes.js';
import { tryHandleKnowledgeRoutes } from './knowledgeRoutes.js';
import { tryHandleExplorerRoutes } from './explorerRoutes.js';
import { isReady, readinessSnapshot } from '../server/readiness.js';
import { checkRequestOrigin } from './originGuard.js';
import { checkHttpAuth, checkMintRequest, describePeer, mintToken, sessionCookieHeader, wsAuthEnabled } from './wsAuth.js';

// Inline HTTP request router, extracted from index.ts in Phase 4 Milestone C.
// Cross-cutting state/primitives arrive via leaf-module imports
// (../server/state.js, ../server/broadcast.js) or as `deps` — the handful of
// index.ts-local closures the routes still reach (mutable `capabilities`, the
// http server handle, the dev-wrapper killer, and the plan/cluster handlers).
// See docs/FILE_SIZE_REFACTOR_PLAN.md.

export interface HttpDeps {
  getCapabilities: () => Capabilities;
  setCapabilities: (c: Capabilities) => void;
  httpServer: import('http').Server;
  wss: import('ws').WebSocketServer;
  killDevWrapper: () => void;
  detachAllForPlan: (cwd: string, planId: string) => Promise<number>;
  handlePlanAttach: (workflowId: string, planId: string) => Promise<void>;
  handleClusterDelete: (clusterId: string) => Promise<void>;
  assertAllMembersClaudeOrCodex: (memberIds: string[]) => Promise<string | null>;
}

function isSystemdServiceMode(): boolean {
  return !!process.env.INVOCATION_ID || !!process.env.SYSTEMD_EXEC_PID;
}

function systemdUnitName(): string {
  return process.env.ARCHON_SYSTEMD_UNIT || 'archon.service';
}

export async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpDeps,
): Promise<void> {
  // Was `Access-Control-Allow-Origin: *` — any page in the operator's browser
  // could drive the file/terminal surface. See originGuard.ts.
  const guard = checkRequestOrigin(req);
  if (!guard.ok) {
    console.warn(`[archon] refused ${req.method} ${(req.url ?? '').split('?')[0]}: ${guard.reason}`);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden origin' }));
    return;
  }
  if (guard.origin) {
    res.setHeader('Access-Control-Allow-Origin', guard.origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename');
  // The upload path posts cross-port in dev (5173 → 3001) with credentials so
  // the session cookie rides along; only ever paired with an allowlisted Origin.
  if (guard.origin) res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Session-cookie mint for the /ws + /terminal upgrade gate (wsAuth.ts). The
  // client calls this before every socket connect; the token rides an HttpOnly
  // cookie, so page JS never holds it.
  if (req.url === '/api/session') {
    if (!wsAuthEnabled()) {
      res.writeHead(204);
      res.end();
      return;
    }
    const verdict = checkMintRequest(req);
    if (!verdict.ok) {
      console.warn(`[archon] refused session mint: ${verdict.reason} (${describePeer(req)})`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session mint refused' }));
      return;
    }
    res.writeHead(204, { 'Set-Cookie': sessionCookieHeader(mintToken()), 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  // Liveness (ARCHON_OPS_PLAN.md §B2). `/healthz` is the canonical route; `/health`
  // is kept as a back-compat alias returning the same body. Always 200 — this
  // branch only runs when the server is up. NOT gated on ARCHON_SERVE_CLIENT, and
  // routed ahead of everything so a supervisor probe can never be shadowed.
  if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'live',
      version: '0.1.0',
      pid: process.pid,
      uptimeSec: readinessSnapshot().uptimeSec,
    }));
    return;
  }

  // Readiness (ARCHON_OPS_PLAN.md §B2). 200 only once capabilities + stores are
  // up; 503 with the pending components during the boot window. Lets a load
  // balancer / k8s gate traffic until boot completes.
  if (req.method === 'GET' && req.url === '/readyz') {
    const snap = readinessSnapshot();
    if (isReady()) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // `pending: []` is emitted on the ready path too so the body shape is
      // symmetric with the 503 below — clients read one field, not two branches.
      res.end(JSON.stringify({ status: 'ready', components: snap.components, pending: snap.pending, uptimeSec: snap.uptimeSec }));
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'not-ready', pending: snap.pending, components: snap.components }));
    }
    return;
  }

  // Preview tab proxy — explicit prefix only at this point. The Referer-based
  // fallback runs further down (just before the 404) so it can't hijack
  // legitimate Archon API requests from any tab whose stale iframe Referer
  // happens to match a preview path. See previewProxy.ts.
  if (tryHandlePreviewRequest(req, res, (wfid) => workflows.get(wfid)?.preview?.port)) {
    return;
  }

  // Session-cookie gate for /api/* + /upload (wsAuth.ts). Placed after the
  // probes, the mint route and the preview prefix proxy; agent tool routes
  // (cluster peer / plan tools) are exempt inside checkHttpAuth.
  const httpAuth = checkHttpAuth(req);
  if (!httpAuth.ok) {
    console.warn(`[archon] refused ${req.method} ${(req.url ?? '').split('?')[0]}: ${httpAuth.reason} (${describePeer(req)})`);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session required' }));
    return;
  }

  // Preview port liveness probe. Used by the PREVIEW tab when the operator
  // clicks a history pill — if the upstream is dead the client surfaces a
  // "service no longer running" modal instead of binding to nothing. Pure
  // HEAD/GET against the loopback port; "anything responding" counts as alive.
  if (req.url?.startsWith('/api/preview/probe') && req.method === 'GET') {
    try {
      const u = new URL(req.url, 'http://x');
      const port = parseInt(u.searchParams.get('port') ?? '', 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid port' }));
        return;
      }
      const alive = await probePreviewPort(port, AbortSignal.timeout(800));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ alive }));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'probe failed' }));
    }
    return;
  }

  // System-wide listing of TCP listeners — Linux-only via /proc. Excludes
  // this Archon server's own PID so we don't surface the proxy itself as a
  // candidate. Workflow-spawned dev servers DO show up (they're descendants
  // of this Archon, but they listen on their own PIDs internally) which is
  // exactly what the operator wants: "what could I bind to?"
  if (req.url === '/api/preview/listening' && req.method === 'GET') {
    try {
      const entries = await listAllListeningProcesses(process.pid);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries }));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'listing failed' }));
    }
    return;
  }

  if (req.url === '/upload' && req.method === 'POST') {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      // 2026-08-07 — a laptop paste produced an empty POST body; the 0-byte
      // file staged as a real attachment and its empty base64 image block
      // poisoned a Native worker's history for every later turn. An empty
      // upload is never useful — reject it so the client never stages it.
      if (body.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Empty upload body' }));
        return;
      }
      const rawFilename = typeof req.headers['x-filename'] === 'string' && req.headers['x-filename'].trim()
        ? req.headers['x-filename'].trim()
        : `upload-${Date.now()}`;
      const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'].split(';')[0].trim().toLowerCase() : '';
      const ext = extname(rawFilename);
      const inferredExt = !ext && contentType ? UPLOAD_IMAGE_EXT[contentType] : undefined;
      const filename = basename(rawFilename) + (inferredExt ?? '');
      const fileId = crypto.randomUUID().slice(0, 8);
      const savePath = join(UPLOADS_DIR, `${fileId}-${filename}`);
      await writeFile(savePath, body);
      console.log(`[archon] File uploaded: ${filename} -> ${savePath}`);
      // Model-side downscale runs in the background; providers await it
      // (bounded) at turn start. The original stays byte-for-byte as sent.
      queueModelImage(savePath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fileId, filename, path: savePath }));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upload failed' }));
    }
    return;
  }

  if (req.url === '/api/mkdir' && req.method === 'POST') {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
        parent?: string;
        name?: string;
      };
      const parent = typeof body.parent === 'string' ? body.parent : '';
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!parent || !name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'parent and name are required' }));
        return;
      }
      if (name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.startsWith('.')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'name must be a single, non-hidden path segment' }));
        return;
      }
      const resolvedParent = safeDirectory(resolve(parent));
      const target = join(resolvedParent, name);
      await mkdir(target, { recursive: true });
      console.log(`[archon] Created directory: ${target}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: target }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url?.startsWith('/api/list-dirs') && req.method === 'GET') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    // No explicit path → start at the operator-configured default, then
    // ~/Projects, then $HOME. The setting is what lets a machine whose work
    // doesn't live under ~/Projects (e.g. a Mac) repoint the browser root.
    const settings = await readSettings().catch(() => null);
    const fallbackRoot = settings?.defaultWorkingDirectory || join(homedir(), 'Projects');
    const requested = url.searchParams.get('path') || fallbackRoot;
    const listAt = async (dir: string) => {
      const { root, entries } = await listBrowserDirectory(dir, true);
      const dirs = entries.map(({ name, path }) => ({ name, path }))
        .sort((a, b) => compareDirectoryNames(a.name, b.name));
      return { parent: root, dirs };
    };
    // Resolve the listing BEFORE writing headers — listAt() can throw and the
    // fallback must be free to write its own headers (writing first then
    // awaiting would double-writeHead → ERR_HTTP_HEADERS_SENT and crash).
    let payload: Awaited<ReturnType<typeof listAt>>;
    try {
      payload = await listAt(requested);
    } catch {
      // The requested/configured dir is unreadable (a Linux default path opened
      // on a Mac, a deleted folder, …). Fall back to $HOME so the browser always
      // has somewhere to stand WITH a working ↑ UP — never a dead-end empty list
      // (the old behavior, which is what made "can't browse" happen off-box).
      try {
        payload = await listAt(homedir());
      } catch {
        payload = { parent: '', dirs: [] };
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  if (await tryHandleClusterSnapshotRoutes(req, res)) return;

  if (await tryHandleClusterRoutes(req, res, deps)) return;

  if (await tryHandleWorkflowDataRoutes(req, res, deps)) return;

  if (await tryHandleDiffRoutes(req, res)) return;

  if (await tryHandleGitDiffRoutes(req, res)) return;

  if (await tryHandleGitWorktreeRoutes(req, res)) return;

  if (await tryHandleGitBakeoffRoutes(req, res)) return;

  if (await tryHandleGitCompareRoutes(req, res)) return;

  // I3 — direct local git ops (POST /api/git/op/*). Distinct prefix from
  // /api/git/status|checkout|diff|compare|fetch above, so no collision.
  if (await tryHandleGitOpRoutes(req, res)) return;

  if (await tryHandleFileWriteRoutes(req, res)) return;

  if (await tryHandleSearchRoutes(req, res)) return;

  if (await tryHandleVoiceRoutes(req, res)) return;
  if (await tryHandleDeepSeekRoutes(req, res)) return;

  if (await tryHandleRecallRoutes(req, res)) return;

  if (await tryHandleKnowledgeRoutes(req, res)) return;

  // ARCHIVE — the standalone file-explorer window's HTTP surface. POST
  // /api/explorer/open (window launch) + read-only GET artifacts/recents/
  // changed lenses. Distinct /api/explorer/ prefix, so no collision.
  if (await tryHandleExplorerRoutes(req, res)) return;

  // D3 — Usage analytics over time (read-only aggregation of existing
  // primary_turn_token_usage events under a cwd; no new capture). Distinct
  // /api/usage-stats prefix, so no collision with /api/usage or /api/recall.
  if (await tryHandleUsageStatsRoutes(req, res)) return;

  // D2 — Endpoint auto-discovery (tailscale peers + localhost, bounded ports).
  if (await tryHandleEndpointDiscoveryRoutes(req, res)) return;

  // Ops A1 — Diagnostics report (read-only grouped status checks). Distinct
  // /api/diagnostics prefix; backs the System modal's Diagnostics tab.
  if (await tryHandleDiagnosticsRoutes(req, res)) return;

  // DD7 — project-trust manager (list / record / clear). User-scope file, so it
  // rides HTTP: the global SettingsPanel has no workflowId for the WS message.
  if (await tryHandleProjectTrustRoutes(req, res)) return;

  // Ops L1/L2 — Local services. GET /api/services is read-only enumeration of
  // listening TCP sockets → process/cwd/framework; DELETE /api/services/:pid is
  // the operator-confirmed SIGTERM kill (guarded by a re-scan + self-kill
  // refusal). Distinct /api/services prefix; backs the L2 Services tab.
  if (await tryHandleServicesRoutes(req, res)) return;

  // G2 — Cookbook catalog search + hardware (distinct /api/cookbook/ prefix).
  if (await tryHandleCookbookRoutes(req, res)) return;

  // H6 — Media ops (POST /api/media/op) + guarded raw-media serve
  // (GET /api/media/raw). Distinct /api/media/ prefix, so no collision.
  if (await tryHandleMediaOpsRoutes(req, res)) return;

  // H2 part 1 — guarded raster-image write (POST /api/image/write). Pure-fs save
  // the image editor POSTs an edited canvas to; resolveWithinCwd-confined +
  // overwrite-confirm + size cap. Distinct /api/image/ prefix, so no collision.
  if (await tryHandleImageWriteRoutes(req, res)) return;

  // Git status for the GIT composer popup. Read-only — populates branch
  // dropdown, ahead/behind, dirty count, GitHub-remote detection.
  if (req.url?.startsWith('/api/git/status') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('path');
      if (!cwd) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path query required' }));
        return;
      }
      const status = await getGitStatus(cwd);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  // Branch checkout / create. Refuses on dirty trees (operator commits
  // first via the GIT popup's COMMIT action). Validates branch names.
  if (req.url?.startsWith('/api/git/checkout') && req.method === 'POST') {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}') as {
        path?: string;
        branch?: string;
        create?: { fromBranch?: string };
      };
      if (!parsed.path || !parsed.branch) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path and branch required' }));
        return;
      }
      const create = parsed.create?.fromBranch
        ? { fromBranch: parsed.create.fromBranch }
        : undefined;
      const result = await checkoutBranch(parsed.path, parsed.branch, create);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  if (req.url?.startsWith('/api/toolbox') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const provider = url.searchParams.get('provider') ?? '';
      const transport = url.searchParams.get('transport') || undefined;
      const cwd = url.searchParams.get('cwd') || process.cwd();
      const account = url.searchParams.get('account') || undefined;
      const force = url.searchParams.get('force') === '1';
      const resolved = provider === 'codex'
        ? await resolveProviderAccount('codex', account, cwd)
        : null;
      if (resolved?.codexHome) {
        await ensureCodexAccountHome(resolved.codexHome).catch(() => { /* probe returns the actionable error */ });
      }
      const result = await discoverToolbox({
        provider,
        transport,
        cwd,
        codexHome: resolved?.codexHome,
        force,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message, supported: false, entries: [] }));
    }
    return;
  }

  // ── Archon-managed skills (Phase 1 of operator-features plan). Distinct
  // from /api/toolbox, which surfaces the active provider runtime's native
  // skills as composer chips. /api/skills CRUDs <cwd>/.archon/skills/ and
  // ~/.archon/skills/, and the manifest of names+descriptions is injected
  // into every primary turn's system prompt by handleUserMessage. Full
  // SKILL.md bodies stay on disk; agents read them on demand.
  if (req.url?.startsWith('/api/skills/body') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('cwd') ?? '';
      const scopeParam = url.searchParams.get('scope');
      const slug = url.searchParams.get('slug') ?? '';
      if (scopeParam !== 'project' && scopeParam !== 'global') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'scope must be "project" or "global"' }));
        return;
      }
      if (scopeParam === 'project' && !cwd) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'cwd query required for project scope' }));
        return;
      }
      if (!isValidSlug(slug)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid slug' }));
        return;
      }
      const skill = await readSkillBody(scopeParam as SkillScope, slug, cwd);
      if (!skill) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'skill not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ skill }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // H35 — operator-triggered skill security audit. Read-only + diagnostic: scans
  // the supplied body for invisible unicode + threat patterns and returns the
  // findings. NO install gate (that judgment stays with the operator).
  if (req.url?.startsWith('/api/skills/audit') && req.method === 'POST') {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}') as { body?: string };
      const report = auditSkillContent(typeof parsed.body === 'string' ? parsed.body : '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url?.startsWith('/api/skills') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('cwd') ?? '';
      const catalog = await listSkills(cwd);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(catalog));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url?.startsWith('/api/skills') && req.method === 'POST') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('cwd') ?? '';
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}') as {
        scope?: string;
        slug?: string;
        name?: string;
        description?: string;
        body?: string;
      };
      if (parsed.scope !== 'project' && parsed.scope !== 'global') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'scope must be "project" or "global"' }));
        return;
      }
      if (parsed.scope === 'project' && !cwd) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'cwd query required for project scope' }));
        return;
      }
      const summary = await writeSkill(
        {
          scope: parsed.scope as SkillScope,
          slug: parsed.slug,
          name: parsed.name ?? '',
          description: parsed.description ?? '',
          body: parsed.body ?? '',
        },
        cwd,
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ skill: summary }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url?.startsWith('/api/skills') && req.method === 'DELETE') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('cwd') ?? '';
      const scopeParam = url.searchParams.get('scope');
      const slug = url.searchParams.get('slug') ?? '';
      if (scopeParam !== 'project' && scopeParam !== 'global') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'scope must be "project" or "global"' }));
        return;
      }
      if (scopeParam === 'project' && !cwd) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'cwd query required for project scope' }));
        return;
      }
      if (!isValidSlug(slug)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid slug' }));
        return;
      }
      const ok = await deleteSkill(scopeParam as SkillScope, slug, cwd);
      if (!ok) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'skill not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: true }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // ── Handoff prompts (Phase 3 of operator-features plan). Operators edit
  // the original-worker reflection prompt and the fresh-summarizer framing
  // via the SettingsPanel; project-scoped overrides at <cwd>/.archon/
  // handoff.prompt.md & handoff.summarizer.prompt.md, global at ~/.archon/.
  // GET returns the full editor state in one call (defaults + per-scope
  // bodies + which scope is winning). POST writes a single (scope, mode)
  // pair; DELETE removes a single (scope, mode) override (revert).
  if (req.url?.startsWith('/api/handoff-prompts') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('cwd') ?? '';
      const modes: HandoffPromptMode[] = ['original-worker', 'fresh-summarizer', 'ollama-compaction'];
      const project: Record<HandoffPromptMode, string | null> = {
        'original-worker': null,
        'fresh-summarizer': null,
        'ollama-compaction': null,
      };
      const global: Record<HandoffPromptMode, string | null> = {
        'original-worker': null,
        'fresh-summarizer': null,
        'ollama-compaction': null,
      };
      const effective: Record<HandoffPromptMode, { source: string; sourcePath: string | null }> = {
        'original-worker': { source: 'default', sourcePath: null },
        'fresh-summarizer': { source: 'default', sourcePath: null },
        'ollama-compaction': { source: 'default', sourcePath: null },
      };
      for (const mode of modes) {
        if (cwd) {
          try { project[mode] = await readHandoffOverride('project', mode, cwd); } catch { project[mode] = null; }
        }
        try { global[mode] = await readHandoffOverride('global', mode, ''); } catch { global[mode] = null; }
        const eff = await loadHandoffPrompt(mode, cwd);
        effective[mode] = { source: eff.source, sourcePath: eff.sourcePath };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        defaults: HANDOFF_DEFAULT_TEMPLATES,
        project,
        global,
        effective,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url?.startsWith('/api/handoff-prompts') && req.method === 'POST') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('cwd') ?? '';
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const parsed = JSON.parse(raw || '{}') as {
        scope?: string;
        mode?: string;
        body?: string;
      };
      if (parsed.scope !== 'project' && parsed.scope !== 'global') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'scope must be "project" or "global"' }));
        return;
      }
      if (parsed.mode !== 'original-worker' && parsed.mode !== 'fresh-summarizer' && parsed.mode !== 'ollama-compaction') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'mode must be "original-worker", "fresh-summarizer", or "ollama-compaction"' }));
        return;
      }
      if (parsed.scope === 'project' && !cwd) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'cwd query required for project scope' }));
        return;
      }
      const body = parsed.body ?? '';
      const validation = validateHandoffOverride(parsed.mode as HandoffPromptMode, body);
      await writeHandoffOverride(
        parsed.scope as HandoffPromptScope,
        parsed.mode as HandoffPromptMode,
        cwd,
        body,
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ saved: true, warnings: validation.warnings }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url?.startsWith('/api/handoff-prompts') && req.method === 'DELETE') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const cwd = url.searchParams.get('cwd') ?? '';
      const scopeParam = url.searchParams.get('scope');
      const modeParam = url.searchParams.get('mode');
      if (scopeParam !== 'project' && scopeParam !== 'global') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'scope must be "project" or "global"' }));
        return;
      }
      if (modeParam !== 'original-worker' && modeParam !== 'fresh-summarizer' && modeParam !== 'ollama-compaction') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'mode must be "original-worker", "fresh-summarizer", or "ollama-compaction"' }));
        return;
      }
      if (scopeParam === 'project' && !cwd) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'cwd query required for project scope' }));
        return;
      }
      const removed = await deleteHandoffOverride(
        scopeParam as HandoffPromptScope,
        modeParam as HandoffPromptMode,
        cwd,
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: removed }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // Cluster presets — operator-saved cluster member templates. CRUD against
  // ~/.archon/cluster-presets.json. See clusterPresets.ts for the on-disk
  // shape + validation rules. Cwd is intentionally NOT part of a preset —
  // operators apply the same shape to whatever cwd they pick next.
  if (req.url === '/api/cluster-presets' && req.method === 'GET') {
    try {
      const presets = await listClusterPresets();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ presets }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url === '/api/cluster-presets' && req.method === 'POST') {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const parsed = JSON.parse(raw || '{}') as {
        name?: unknown;
        clusterNameTemplate?: unknown;
        members?: unknown;
      };
      const name = typeof parsed.name === 'string' ? parsed.name : '';
      const clusterNameTemplate = typeof parsed.clusterNameTemplate === 'string' ? parsed.clusterNameTemplate : undefined;
      const members = Array.isArray(parsed.members) ? (parsed.members as unknown[]) : [];
      // Cast through unknown — clusterPresets.normalizeMember validates each
      // entry field-by-field, so handing it `unknown[]` and letting it throw
      // is the cleanest seam (no double-validation here).
      const preset = await saveClusterPreset({
        name,
        ...(clusterNameTemplate ? { clusterNameTemplate } : {}),
        members: members as ClusterPresetMember[],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ preset }));
    } catch (err) {
      if (err instanceof PresetValidationError) {
        res.writeHead(err.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url?.startsWith('/api/cluster-presets/') && req.method === 'DELETE') {
    try {
      const id = req.url.slice('/api/cluster-presets/'.length).split(/[?#]/)[0];
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'preset id required' }));
        return;
      }
      const removed = await deleteClusterPreset(id);
      if (!removed) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'preset not found' }));
        return;
      }
      res.writeHead(204);
      res.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // Workbench Expansion §D4 — project / session templates ("recipes"). CRUD
  // against ~/.archon/templates.json. See server/src/templates/store.ts for the
  // on-disk shape + validation. Single-tab analogue of cluster presets; the
  // persisted model is validated against the live catalog at APPLY time on the
  // client (survives model renames), not here.
  if (req.url === '/api/templates' && req.method === 'GET') {
    try {
      const templates = await listTemplates();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ templates }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url === '/api/templates' && req.method === 'POST') {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const parsed = JSON.parse(raw || '{}') as {
        name?: unknown;
        config?: unknown;
        seedPrompt?: unknown;
        plan?: unknown;
      };
      const name = typeof parsed.name === 'string' ? parsed.name : '';
      // saveTemplate.normalizeConfig validates the config field-by-field, so
      // hand it the raw value and let it throw (no double-validation here).
      const template = await saveTemplate({
        name,
        config: parsed.config,
        ...(typeof parsed.seedPrompt === 'string' ? { seedPrompt: parsed.seedPrompt } : {}),
        ...(typeof parsed.plan === 'string' ? { plan: parsed.plan } : {}),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ template }));
    } catch (err) {
      if (err instanceof TemplateValidationError) {
        res.writeHead(err.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url?.startsWith('/api/templates/') && req.method === 'DELETE') {
    try {
      const id = req.url.slice('/api/templates/'.length).split(/[?#]/)[0];
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'template id required' }));
        return;
      }
      const removed = await deleteTemplate(id);
      if (!removed) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'template not found' }));
        return;
      }
      res.writeHead(204);
      res.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url === '/api/capabilities' && req.method === 'GET') {
    const current = deps.getCapabilities();
    const runtime = await refreshRuntimeVersions(current);
    // Preserve CLI/upstream changes completed while the local probe awaited IO.
    const next = { ...deps.getCapabilities(), strataVersion: runtime.strataVersion, xolotlRevision: runtime.xolotlRevision };
    deps.setCapabilities(next);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(next));
    return;
  }

  // /api/docs?file=<repo-relative path> — serves source files (md / source
  // code) under PROJECT_ROOT for the in-app DocViewer. Whitelist-by-extension
  // keeps the surface tight — there are no secrets in the Archon repo, but
  // there's no reason to expose .env / credentials.json / etc. either.
  // Path resolution is canonical and re-checked against PROJECT_ROOT to
  // block any traversal that survives `..` rejection.
  if (req.url?.startsWith('/api/docs') && req.method === 'GET') {
    const ALLOWED_EXTS = new Set(['.md', '.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.html', '.sh', '.yml', '.yaml', '.toml']);
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const requested = u.searchParams.get('file') ?? '';
      if (!requested || requested.includes('..') || requested.startsWith('/')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid file' }));
        return;
      }
      const ext = extname(requested).toLowerCase();
      if (!ALLOWED_EXTS.has(ext)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `extension not allowed: ${ext}` }));
        return;
      }
      const fullPath = resolve(PROJECT_ROOT, requested);
      // Belt + suspenders: even after `..` rejection, ensure the canonical
      // path stayed inside PROJECT_ROOT (catches symlink shenanigans).
      if (!fullPath.startsWith(PROJECT_ROOT + sep) && fullPath !== PROJECT_ROOT) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path escape' }));
        return;
      }
      const content = await readFile(confinedPath(fullPath, [PROJECT_ROOT]), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: requested, content }));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const status = code === 'ENOENT' ? 404 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  if (req.url?.startsWith('/api/cli-snapshot') && req.method === 'GET') {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const name = u.searchParams.get('name') ?? '';
      // Traversal guard: only bare filenames under the snapshot dir.
      if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid name' }));
        return;
      }
      const full = join(cliSnapshotDir(), name);
      const contents = await readFile(full, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ contents, bytes: Buffer.byteLength(contents, 'utf8') }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url && (req.url === '/api/settings' || req.url.startsWith('/api/settings?')) && req.method === 'GET') {
    try {
      // Phase 2 — optional ?cwd=<path> layers <cwd>/.archon/settings.json on
      // top of the global cascade. Path-traversal isn't a concern here: we
      // only read; the cwd is operator-supplied (their own active workflow
      // cwd) and readSettings only opens <cwd>/.archon/settings.json.
      const url = new URL(req.url, 'http://localhost');
      const cwdParam = url.searchParams.get('cwd') ?? undefined;
      const settings = await readSettings(cwdParam);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(settings));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url === '/api/settings' && req.method === 'POST') {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const patch = JSON.parse(body || '{}') as Partial<ArchonSettings>;
      const updated = await patchSettings(patch);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updated));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url === '/api/catalog' && req.method === 'GET') {
    try {
      const contents = (await readCatalog()) ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ contents, bytes: Buffer.byteLength(contents, 'utf8') }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url === '/api/catalog' && req.method === 'POST') {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}') as { contents?: string };
      if (typeof parsed.contents !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'expected { contents: string }' }));
        return;
      }
      await writeCatalog(parsed.contents);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bytes: Buffer.byteLength(parsed.contents, 'utf8') }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // Debug endpoint for simulating a throttle flip. Used by acceptance tests.
  if (req.url?.startsWith('/api/debug/throttle') && req.method === 'POST') {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const raw = url.searchParams.get('provider') || '';
      if (raw !== 'claude' && raw !== 'gemini' && raw !== 'codex' && raw !== 'ollama') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'provider must be claude|gemini|codex|ollama' }));
        return;
      }
      const provider = raw as ProviderName;
      if (url.searchParams.get('clear') === '1') {
        quotaMarkAvailable(provider);
      } else {
        const resetsAt = Number(url.searchParams.get('resets')) || (Date.now() + 30 * 60 * 1000);
        quotaMarkThrottled(provider, '[manual throttle via /api/debug/throttle]', resetsAt);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, providers: quotaWireSnapshot() }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url === '/api/auth-status' && req.method === 'GET') {
    const status = await getAuthStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return;
  }

  // Live Ollama daemon snapshot for the header indicator (LIVE/READY/DOWN
  // + currently-loaded model). Client polls only while the operator has
  // ollama enabled in settings AND the auth probe last reported the
  // daemon up — disabled or unreachable Ollama means no polling at all.
  if (req.url === '/api/ollama-live' && req.method === 'GET') {
    const live = await probeOllamaLive();
    const body = { ...live, fetchedAt: Date.now() };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  // M12 (Excellence LE-6) — model-lifecycle console: aggregate /api/ps across
  // ALL configured Ollama backends (M4 list) with the idle/expiry countdown +
  // per-backend cooldown flag. Fail-soft per backend (a down host is a row with
  // reachable:false, not a 500). Polled on demand by the CONFIG-tab MODEL
  // LIFECYCLE section. Read-only — no mutation, mirrors /api/ollama-live's
  // metadata-only posture.
  if (req.url === '/api/ollama-ps' && req.method === 'GET') {
    try {
      const agg = await aggregateOllamaPs();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(agg));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // M12 — operator-facing keep_alive:0 unload. Frees a model's VRAM on demand
  // (the open-webui /api/unload trick) targeting the SPECIFIC backend it's
  // loaded on (the console knows it from the aggregation row). Operator-
  // initiated + non-destructive (reversible: the next turn reloads from disk) +
  // visible: when a workflowId is supplied (the console is per-tab) the action
  // lands in that tab's events.jsonl via broadcastWorkflow so transcript review
  // sees it — same visibility channel M3–M11 use for routing/compaction.
  if (req.url === '/api/local-models/unload' && req.method === 'POST') {
    try {
      const report = await unloadLocalModels();
      res.writeHead(report.blocked ? 409 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err), results: [] }));
    }
    return;
  }

  if (req.url === '/api/ollama-unload' && req.method === 'POST') {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const parsed = JSON.parse(raw || '{}') as { model?: unknown; baseUrl?: unknown; label?: unknown; workflowId?: unknown };
      const model = typeof parsed.model === 'string' ? parsed.model.trim() : '';
      const baseUrl = typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined;
      const label = typeof parsed.label === 'string' && parsed.label.trim().length > 0 ? parsed.label.trim() : (baseUrl ?? 'primary');
      const workflowId = typeof parsed.workflowId === 'string' && parsed.workflowId.length > 0 ? parsed.workflowId : null;
      if (!model) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'model required' }));
        return;
      }
      const result = await unloadOllamaModel(model, baseUrl);
      if (workflowId) {
        // Visibility (four-question test): log the unload to the tab's
        // transcript whether it succeeded or not, so a failed eviction is
        // reviewable too. broadcastWorkflow persists to events.jsonl + pushes
        // the notice to the connected client.
        broadcastWorkflow(workflowId, {
          type: 'system_notice',
          workflowId,
          content: result.ok
            ? `[ollama] Unloaded "${model}" from ${label} (keep_alive:0). VRAM freed — the next turn reloads it from disk.`
            : `[ollama] Unload of "${model}" from ${label} failed: ${result.error ?? 'unknown error'}`,
        });
      }
      res.writeHead(result.ok ? 200 : 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.ok ? { unloaded: true } : { error: result.error ?? 'unload failed' }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // ── VRAM budget readout (hardware-synergy) ── the LOCAL board's GPU VRAM
  // (nvidia-smi via the Cookbook hardware probe) vs what the local Ollama daemon
  // currently has resident (/api/ps size_vram). Read-only, fail-soft: no GPU /
  // down daemon degrades to available:false / daemonUp:false, never a 500.
  // Powers the CONFIG-tab VRAM BUDGET readout. Local-only by design.
  if (req.url === '/api/ollama/vram' && req.method === 'GET') {
    try {
      const report = await computeVramReport();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // ── Auto context-sizer (hardware-synergy) ── predictive fit estimate: given
  // the primary model (+ optional utility model), size the largest num_ctx the
  // primary can use on this GPU, reserving headroom for a LOCAL utility model (a
  // remote utility costs zero local VRAM). Powers the "set to fit" button + the
  // coexistence warning. Read-only estimate — writing num_ctx goes through the
  // normal updatePrimaryConfig path so the prefix-cache invalidation is logged.
  if (req.url === '/api/ollama/fit' && req.method === 'POST') {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const parsed = JSON.parse(raw || '{}') as { primary?: unknown; utility?: unknown; utilityRemote?: unknown };
      const primary = typeof parsed.primary === 'string' ? parsed.primary.trim() : '';
      if (!primary) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'primary model required' }));
        return;
      }
      const utility = typeof parsed.utility === 'string' && parsed.utility.trim().length > 0 ? parsed.utility.trim() : null;
      const utilityRemote = parsed.utilityRemote === true;
      const report = await computeOllamaFit({ primary, utility, utilityRemote });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // Live llama-server snapshot. Same gating discipline as the Ollama
  // endpoint: client polls only when enabledProviders.llamacpp is true and
  // the auth probe last reported llama-server present. The lifecycle
  // manager owns the spawned process; this just reports its current state
  // (idle / loading / ready) plus the binary version chip needs.
  if (req.url === '/api/llamacpp-live' && req.method === 'GET') {
    const live = await probeLlamacppLive();
    const body = { ...live, fetchedAt: Date.now() };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  // Operator-facing manual unload — frees the VRAM without waiting for the
  // idle timer. Useful when switching to a different GPU workload.
  if (req.url === '/api/llamacpp-unload' && req.method === 'POST') {
    try {
      await llamacppManager.unload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ unloaded: true }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // Operator-facing preload — loads a registered alias into VRAM without
  // having to fire a workflow turn. Hides the 20-30s cold-start behind an
  // explicit click instead of making the next message pay for it. Returns
  // 200 once /health passes (manager.ensureLoaded blocks on readiness).
  if (req.url?.startsWith('/api/llamacpp-load') && req.method === 'POST') {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const alias = url.searchParams.get('alias') || '';
      if (!alias) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing ?alias=' }));
        return;
      }
      const loaded = await llamacppManager.ensureLoaded(alias);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ alias: loaded.alias, port: loaded.port, pid: loaded.pid }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // Catalog CRUD. GET returns the operator-managed model registry; POST
  // accepts the full catalog and atomic-writes it. Same pattern as the
  // models.md catalog endpoint — wholesale replace, not patch, so the
  // editor UI never has to merge concurrent edits.
  if (req.url === '/api/llamacpp/catalog' && req.method === 'GET') {
    try {
      const catalog = await readLlamacppCatalog();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(catalog));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }
  if (req.url === '/api/llamacpp/catalog' && req.method === 'POST') {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}') as unknown;
      // Server-side shape validation: enforce {models: LlamacppModelDef[]}.
      // We're permissive on the model fields themselves (catalog read does
      // its own filter on bad entries) — the strict gate here is just the
      // top-level shape so an obviously-broken POST doesn't overwrite the
      // operator's working file.
      if (!body || typeof body !== 'object' || !Array.isArray((body as { models?: unknown }).models)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'expected { models: [...] }' }));
        return;
      }
      const next: LlamacppCatalog = { models: (body as { models: LlamacppModelDef[] }).models };
      await writeLlamacppCatalog(next);
      // Re-read so the response reflects what hit disk after validation.
      const persisted = await readLlamacppCatalog();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(persisted));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // Phase 7a — Claude Native auth endpoints. Status / login (PKCE bootstrap)
  // / callback (manual-paste fallback or server-callback completion) /
  // logout. The OAuth bootstrap server-side spawns its own local callback
  // listener on port 53692 when possible; on EADDRINUSE we surface a
  // manual-paste flag and accept the redirect URL via /callback.
  if (req.url === '/api/auth/claude-native' && req.method === 'GET') {
    try {
      const tokens = await loadClaudeNativeTokens();
      const body = tokens
        ? { loggedIn: true, expiresAt: tokens.expiresAt, scopes: tokens.scope ? tokens.scope.split(/\s+/) : undefined }
        : { loggedIn: false };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }
  if (req.url === '/api/auth/claude-native/login' && req.method === 'POST') {
    try {
      const result = await claudeNativeStartBootstrap();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }
  if (req.url === '/api/auth/claude-native/callback' && req.method === 'POST') {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}') as { url?: string };
      if (typeof parsed.url !== 'string' || !parsed.url) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'expected { url: <localhost callback URL> }' }));
        return;
      }
      await claudeNativeCompleteBootstrap(parsed.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }
  if (req.url === '/api/auth/claude-native/logout' && req.method === 'POST') {
    try {
      await clearClaudeNativeTokens();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // Public catalog — Anthropic's /v1/models response, cached for an hour.
  // Refreshes lazily on the next request after the cache expires; failures
  // degrade to the last good snapshot. The UI picker reads this to render
  // the model list, per-model effort gating, and context-window labels.
  // ?force=1 bypasses the cache (operator-driven refresh).
  if (req.url?.startsWith('/api/claude-native/catalog') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const force = url.searchParams.get('force') === '1';
      const snapshot = await getClaudeNativeCatalog(force);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // Live Codex model catalog — short-lived `codex app-server` spawn fetches
  // model/list once an hour. Same shape contract as the Claude endpoint:
  // ?force=1 bypasses the cache. UI picker uses this to surface new Codex
  // models and per-model `supportedReasoningEfforts`.
  //
  // ?account=<profileId> scopes the fetch to that Codex account profile's
  // auth dir (CODEX_HOME) so entitlement-gated availability (e.g. GPT-5.6 Sol
  // on a higher-tier WORK plan) reflects the actual account. Omitted → ambient
  // ~/.codex default. Unknown id resolves to the first configured account.
  if (req.url?.startsWith('/api/codex/catalog') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const force = url.searchParams.get('force') === '1';
      const account = url.searchParams.get('account') || undefined;
      const resolved = account ? await resolveProviderAccount('codex', account) : null;
      if (resolved?.codexHome) await ensureCodexAccountHome(resolved.codexHome).catch(() => { /* fetch will surface a real error */ });
      const snapshot = await getCodexCatalog(force, resolved?.codexHome);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // Live Gemini model catalog — fetched from generativelanguage.googleapis.com
  // using OAuth Bearer tokens piggybacked from ~/.gemini/oauth_creds.json.
  // Same shape contract as the Claude/Codex endpoints: ?force=1 bypasses cache.
  if (req.url?.startsWith('/api/gemini-native/catalog') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const force = url.searchParams.get('force') === '1';
      const snapshot = await getGeminiNativeCatalog(force);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // Live Cursor model catalog — short-lived `cursor-agent models` spawn parses
  // the ~155-row text list once an hour. Same shape contract as the other
  // catalog endpoints: ?force=1 bypasses the cache. UI picker uses this to
  // surface the full Cursor model roster (Grok / GPT-5.x / Claude / Gemini / …).
  if (req.url?.startsWith('/api/cursor/catalog') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const force = url.searchParams.get('force') === '1';
      const snapshot = await getCursorCatalog(force);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // Empirical model-probe — sends a tiny messages.create request through the
  // live OAuth tokens with the standard wire fingerprint. Used to discover
  // which model IDs are actually addressable, what the API echoes back as
  // Message.model, and how beta headers (e.g. context-1m-*) behave per
  // model. No catalog assumptions; let the API tell us.
  if (req.url === '/api/auth/claude-native/probe' && req.method === 'POST') {
    const startedAt = Date.now();
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}') as {
        model?: string;
        beta?: string[];
        maxTokens?: number;
        prompt?: string;
      };
      if (typeof parsed.model !== 'string' || !parsed.model) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'expected { model: string, beta?: string[], maxTokens?: number, prompt?: string }' }));
        return;
      }
      const tokens = await ensureClaudeNativeTokens();
      // Match the worker's wire fingerprint exactly so a probe-passing
      // model translates 1:1 to a real-turn-passing model. Caller-supplied
      // beta entries append (don't replace) the standard ones.
      const stdBetas = ['claude-code-20250219', 'oauth-2025-04-20'];
      const extraBetas = Array.isArray(parsed.beta) ? parsed.beta.filter((s) => typeof s === 'string') : [];
      const betaHeader = [...stdBetas, ...extraBetas].join(',');
      const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${tokens.accessToken}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': betaHeader,
          'user-agent': CLAUDE_CLI_USER_AGENT,
          'x-app': 'cli',
        },
        body: JSON.stringify({
          model: parsed.model,
          max_tokens: parsed.maxTokens ?? 16,
          // The Claude-Code identity block is load-bearing on the OAuth path:
          // without it Anthropic answers a bare 429 "Error" on every model but
          // Haiku (docs/GOTCHAS.md § Claude Native transport, 2026-09-01).
          system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
          messages: [{ role: 'user', content: parsed.prompt ?? 'hi' }],
        }),
      });
      const durationMs = Date.now() - startedAt;
      const text = await apiResp.text();
      let parsedBody: unknown = null;
      try { parsedBody = JSON.parse(text); } catch { /* leave as raw text */ }
      if (apiResp.ok && parsedBody && typeof parsedBody === 'object') {
        const msg = parsedBody as { model?: string; usage?: Record<string, number>; stop_reason?: string };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          status: apiResp.status,
          requestedModel: parsed.model,
          echoedModel: msg.model,
          stopReason: msg.stop_reason,
          usage: msg.usage,
          betaHeader,
          durationMs,
        }));
        return;
      }
      // Error path — surface Anthropic's structured envelope when present.
      let errorType: string | undefined;
      let errorMessage: string | undefined;
      if (parsedBody && typeof parsedBody === 'object') {
        const env = parsedBody as { error?: { type?: string; message?: string } };
        errorType = env.error?.type;
        errorMessage = env.error?.message;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        status: apiResp.status,
        requestedModel: parsed.model,
        errorType,
        errorMessage: errorMessage ?? text.slice(0, 500),
        betaHeader,
        durationMs,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: message, durationMs: Date.now() - startedAt }));
    }
    return;
  }

  if (req.url?.startsWith('/api/auth-login') && req.method === 'POST') {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const raw = url.searchParams.get('provider') || 'claude';
      const provider = raw === 'gemini' ? 'gemini'
        : raw === 'github' ? 'github'
        : raw === 'ollama' ? 'ollama'
        : raw === 'codex' ? 'codex'
        : raw === 'zai' ? 'zai'
        : raw === 'cursor' ? 'cursor'
        : 'claude';
      const account = url.searchParams.get('account') || undefined;
      const result = await triggerAuthLogin(provider, account);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url === '/api/zai-key' && req.method === 'GET') {
    try {
      const status = await zaiApiKeyStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url === '/api/zai-key' && req.method === 'POST') {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}') as { apiKey?: string };
      if (typeof parsed.apiKey !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'expected { apiKey: string }' }));
        return;
      }
      const status = await saveZaiApiKey(parsed.apiKey);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.url === '/api/zai-key' && req.method === 'DELETE') {
    try {
      const status = await clearZaiApiKey();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (await tryHandleGithubRoutes(req, res)) return;

  if (req.url?.startsWith('/api/check-updates') && req.method === 'POST') {
    try {
      const url = new URL(req.url, 'http://localhost');
      const providerParam = url.searchParams.get('provider');
      const provider: CliProvider = providerParam === 'gemini' || providerParam === 'codex'
        ? providerParam
        : 'claude';
      const result = await runCliUpdate(deps.getCapabilities(), provider);
      deps.setCapabilities(result.capabilities);
      for (const [ws] of sessions) {
        send(ws, {
          type: 'capabilities_updated',
          capabilities: result.capabilities,
          updated: result.updated,
          previousVersion: result.previousVersion,
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // Connected-client count. Used by the launcher to decide whether to open
  // a new browser tab: if any client is already connected, the launcher
  // skips xdg-open so clicking the program launcher twice doesn't stack up
  // duplicate tabs. Count is the number of open WebSocket sessions.
  if (req.url === '/api/clients' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: sessions.size }));
    return;
  }

  if (req.url === '/api/shutdown' && req.method === 'POST') {
    console.log('[archon] Shutdown requested');
    for (const [ws] of sessions) {
      try {
        send(ws, { type: 'shutdown', reason: 'server_stopping' });
      } catch { /* socket may be already dead */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ shuttingDown: true }));
    setTimeout(async () => {
      try { deps.wss.close(); } catch { /* ignore */ }
      try { deps.httpServer.close(); } catch { /* ignore */ }
      try { await flushAllWorkflowEvents(); } catch { /* best-effort */ }
      deps.killDevWrapper();
      setTimeout(() => process.exit(0), 300);
    }, 1500);
    return;
  }

  if (req.url === '/api/restart' && req.method === 'POST') {
    console.log('[archon] Restart requested');
    for (const [ws] of sessions) {
      try {
        send(ws, { type: 'shutdown', reason: 'server_restarting' });
      } catch { /* socket may be already dead */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ restarting: true }));
    if (isSystemdServiceMode()) {
      const unit = systemdUnitName();
      console.log(`[archon] Service-mode restart requested — queueing systemd restart for ${unit}`);
      setTimeout(async () => {
        try { deps.wss.close(); } catch { /* ignore */ }
        try { deps.httpServer.close(); } catch { /* ignore */ }
        try { await flushAllWorkflowEvents(); } catch { /* best-effort */ }
        try {
          const child = spawn('systemctl', ['--user', '--no-block', 'restart', unit], {
            detached: true,
            stdio: 'ignore',
          });
          child.unref();
        } catch (err) {
          console.error(`[archon] Failed to queue systemd restart for ${unit}; exiting non-zero for Restart=on-failure fallback`, err);
          process.exit(1);
        }
        // If systemd successfully queued the restart it will stop this
        // process before the fallback fires. If `systemctl` failed after
        // spawn, fall back to the unit's Restart=on-failure path instead
        // of leaving the server with its listener closed.
        setTimeout(() => {
          console.error(`[archon] Service-mode restart fallback fired for ${unit}`);
          process.exit(1);
        }, 10_000).unref();
      }, 50);
      return;
    }
    // Defensive respawn. Prior attempt used a one-liner detached `bash
    // -c` and failed silently — the detached child either got chased
    // down by `concurrently --kill-others` working through tsx watch,
    // or hit EADDRINUSE because 3s wasn't long enough for the dev tree
    // to release ports 3001/5173. Fixes stacked here:
    //   1. Write the respawn command to a temp script so the launcher
    //      invocation is a plain `bash <script>` with no inline -c quote
    //      escaping to worry about.
    //   2. Launch with `detached: true` so Node calls setsid(2) on the
    //      child — new session, no controlling terminal, no SIGHUP
    //      source. `stdio: 'ignore'` plus the script's own redirect to
    //      the respawn log means nohup is redundant too. We used to
    //      wrap with `setsid nohup` but setsid isn't installed on macOS
    //      by default, so the spawn ENOENT'd and the restart died
    //      silently. Plain `bash <script>` works on both platforms.
    //   3. Log stdout/stderr to /tmp/archon-respawn.log so we can diagnose
    //      whatever goes wrong next time instead of flying blind.
    //   4. Sleep 5s (was 3s) to give the dev wrapper + concurrently more
    //      time to fully tear down before rebinding ports.
    const respawnLog = `${tmpdir()}/archon-respawn.log`;
    const respawnScript = `${tmpdir()}/archon-respawn-${process.pid}.sh`;
    try {
      // Previous attempt wrote its startup line and then silently died
      // during `sleep 5`, somewhere between killDevWrapper's pkill and
      // whatever the concurrently --kill-others cascade does to orphan
      // children. The trap-to-echo handlers below catch SIGTERM/HUP/INT,
      // log them, and (by virtue of being handled rather than running
      // the default action) leave bash running. Also: `set -e` dropped
      // because `sleep` was exiting non-zero when interrupted by the
      // signal, which with `-e` terminates the shell. The explicit
      // `|| echo` after sleep means even if it exits non-zero we keep
      // going rather than bailing. Extra echoes at each step so the
      // next failure mode (if any) is unambiguous in the log.
      // SIGKILL-based teardown (2026-04-24): killDevWrapper now SIGKILLs
      // concurrently + tsx + vite directly, so by the time this script's
      // grace period elapses the old tree is gone, sockets are released,
      // and there's nothing left to race with. A short grace (500ms) just
      // lets the kernel finish reaping; we no longer need port-polling or
      // process-polling. If you're hunting a future regression, the prior
      // two attempts live in git history:
      //   - fixed sleep 5s (racy)
      //   - /dev/tcp port-poll (still racy against tsx force-kill)
      const scriptBody = [
        '#!/usr/bin/env bash',
        'set -uo pipefail',
        `exec >> "${respawnLog}" 2>&1`,
        `echo "---"`,
        `echo "[archon-respawn] $(date -Iseconds) pid=$$ parent-was=${process.pid}"`,
        // Traps kept so a stray signal against our session doesn't take
        // us down before we get to the exec.
        `trap 'echo "[archon-respawn] SIGTERM received (ignored)"' TERM`,
        `trap 'echo "[archon-respawn] SIGHUP received (ignored)"' HUP`,
        `trap 'echo "[archon-respawn] SIGINT received (ignored)"' INT`,
        `echo "[archon-respawn] traps armed, brief grace before exec"`,
        // 1s grace is comfortably longer than the parent's 50ms response
        // delay + flushAllWorkflowEvents + pkill. The kill is effectively
        // instantaneous (SIGKILL releases sockets immediately), so this
        // is just a margin against jitter.
        'sleep 1 || true',
        `echo "[archon-respawn] cd to ${PROJECT_ROOT}"`,
        `cd "${PROJECT_ROOT}"`,
        `echo "[archon-respawn] cwd=$(pwd), PATH=$PATH"`,
        `echo "[archon-respawn] which npm: $(which npm || echo MISSING)"`,
        'echo "[archon-respawn] exec npm run dev"',
        'exec npm run dev',
        '',
      ].join('\n');
      writeFileSync(respawnScript, scriptBody, { encoding: 'utf8' });
      chmodSync(respawnScript, 0o755);
      const child = spawn('bash', [respawnScript], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      console.log(`[archon] Respawn queued — script=${respawnScript} log=${respawnLog}`);
    } catch (err) {
      console.error('[archon] Failed to queue respawn:', err);
    }
    // Tight delay (50ms) so the HTTP response and WS shutdown frames flush
    // onto the wire before we self-immolate. Must complete before the
    // respawn script's grace period (1s) elapses, otherwise the new `npm
    // run dev` races against the still-alive old tree — vite finds 5173
    // held, fails over to 5174, then concurrently --kill-others tears the
    // new tree down. Previously this was 1500ms, which lost the race.
    setTimeout(async () => {
      try { deps.wss.close(); } catch { /* ignore */ }
      try { deps.httpServer.close(); } catch { /* ignore */ }
      try { await flushAllWorkflowEvents(); } catch { /* best-effort */ }
      deps.killDevWrapper();
      // killDevWrapper SIGKILLs our pattern (which includes our own
      // tsx/dist node), so this is unreachable in practice — kept as a
      // safety net for the case where the pattern misses our pid.
      setTimeout(() => process.exit(0), 200);
    }, 50);
    return;
  }

  if (req.url?.startsWith('/api/usage') && req.method === 'GET') {
    const force = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('force') === '1';
    const usage = await getUsage(force);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(usage));
    return;
  }

  if (req.url?.startsWith('/api/codex-usage') && req.method === 'GET') {
    const force = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('force') === '1';
    const usage = await getCodexUsage(force);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(usage));
    return;
  }

  if (req.url?.startsWith('/api/codex-usage-login') && req.method === 'POST') {
    const result = await launchCodexUsageLogin();
    res.writeHead(result.started ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.url?.startsWith('/api/cursor-usage') && req.method === 'GET') {
    const force = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('force') === '1';
    const usage = await getCursorUsage(force);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(usage));
    return;
  }

  if (req.url?.startsWith('/api/zai-usage') && req.method === 'GET') {
    const force = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('force') === '1';
    const usage = await getZaiUsage(force);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(usage));
    return;
  }

  if (req.url?.startsWith('/api/file-content') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const path = url.searchParams.get('path') || '';
      const cwd = url.searchParams.get('cwd') || '';
      const workflowId = url.searchParams.get('workflowId') || '';
      const target = await resolveBrowserRead(path, cwd, workflowId);
      const payload = await readFileForExplorer(target);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead((err as NodeJS.ErrnoException).code === 'EACCES' ? 403 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: message }));
    }
    return;
  }

  if (req.url?.startsWith('/api/files') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const dir = url.searchParams.get('path') || '.';
      const { root: resolved, entries } = await listBrowserDirectory(dir, false);
      const files = entries
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return compareDirectoryNames(a.name, b.name);
        });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: resolved, files }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: '', files: [] }));
    }
    return;
  }

  // Last-chance preview fallback — if a request didn't match any Archon route
  // and its Referer points to a preview iframe, route it through that
  // workflow's backend (handles Vite's absolute-path sub-resources without
  // base-url config).
  if (tryHandlePreviewRequest(req, res, (wfid) => workflows.get(wfid)?.preview?.port, { allowReferer: true })) {
    return;
  }

  // Production static-serve of the built client (ARCHON_OPS_PLAN §B1). Gated on
  // an EXPLICIT opt-in env flag, NOT NODE_ENV: in dev Vite on 5173 owns the
  // client and proxies here, so we must stay 100% inert unless `archon service`
  // (the systemd unit) sets ARCHON_SERVE_CLIENT=1. Runs after every API/preview
  // route and only for GET, so it can never shadow an Archon endpoint. Falls
  // through to the 404 if client/dist is absent (un-built) — never crashes.
  if (process.env.ARCHON_SERVE_CLIENT === '1' && req.method === 'GET') {
    if (await tryServeClientDist(req, res)) return;
  }

  res.writeHead(404);
  res.end();
}

// Static-file serve of client/dist with SPA fallback. Returns true if it wrote
// a response (file hit or index.html fallback), false to let the caller 404.
// Path is canonicalized and re-checked against client/dist to block traversal.
const CLIENT_DIST = join(PROJECT_ROOT, 'client', 'dist');
const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

async function tryServeClientDist(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    return false;
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  // Resolve against client/dist and confirm the canonical path stayed inside —
  // belt + suspenders over URL parsing already stripping `..` segments.
  const candidate = resolve(CLIENT_DIST, '.' + pathname);
  const inDist = candidate === CLIENT_DIST || candidate.startsWith(CLIENT_DIST + sep);

  const sendFile = async (file: string, status: number): Promise<boolean> => {
    try {
      const body = await readFile(file);
      const ext = extname(file).toLowerCase();
      const headers: Record<string, string> = {
        'Content-Type': STATIC_CONTENT_TYPES[ext] ?? 'application/octet-stream',
      };
      // index.html must never be cached — it's the entry that references the
      // hashed asset bundle; a stale copy points at evicted chunks.
      if (file.endsWith('index.html')) headers['Cache-Control'] = 'no-store';
      res.writeHead(status, headers);
      res.end(body);
      return true;
    } catch {
      return false;
    }
  };

  if (inDist) {
    // Asset paths (have an extension) must hit a real file or 404 — no SPA
    // fallback for a missing .js/.css, or the browser gets HTML where it
    // expects a script. Extension-less paths fall through to index.html.
    if (extname(pathname) && (await sendFile(candidate, 200))) return true;
    if (!extname(pathname) && (await sendFile(candidate, 200))) return true;
  }

  // SPA fallback: serve index.html for unmatched non-asset paths (deep links).
  if (!extname(pathname)) {
    return sendFile(join(CLIENT_DIST, 'index.html'), 200);
  }
  return false;
}
