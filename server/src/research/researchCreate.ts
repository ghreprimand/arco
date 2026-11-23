// docs/RESEARCH.md - creating a research project on the normal
// cluster_create_from_scratch path. The first member is the Research
// Director (STANDARD, working in the new research folder); every other
// member is a RESEARCHER whose workflow folder lives in Arco state.

import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  RESEARCH_MAX_RESEARCHERS,
  isResearcherProvider,
  type ClusterCreateFromScratchMessage,
  type ClusterMemberProvider,
} from '@arco/shared';
import { assertSafePath } from '../fileAccessPolicy.js';
import { arcoHome } from '../arcoHome.js';
import { ensureStorageRoot } from '../storageRoot.js';
import { patchSettings, readSettings } from '../settings.js';
import { researchSandboxAvailable } from '../workers/researchSandboxAvailability.js';
import { geminiResearchSignInState } from '../providers/antigravity/researchSignIn.js';
import { cursorIsolationReason } from '../providers/cursor/isolatedVersion.js';
import { codexResearchVersionReason, installedCodexVersion } from '../providers/codexVersion.js';
import { readMeta } from '../workflowMeta.js';
import { createResearchFolder, writeInitialFiles, writeProjectFiles, writeReleasedRound } from './researchFolder.js';
import { addToLibrary, reopenSource } from './researchLibrary.js';
import { recordResearchExport } from './sendToProject.js';
import { loadResearch, initResearch, researchLetter, researcherName, type ResearchRound, type ResearchState } from './researchState.js';

export const RESEARCH_DIRECTOR_ROLE = 'Research Director';
export const RESEARCHER_ROLE = 'Researcher';
export const RESEARCH_NAME_MAX = 60;
export const RESEARCH_BRIEF_MAX = 20_000;

export interface PreparedResearch {
  projectId: string;
  quick?: boolean;
  folder: string;
  membersCwd: string;
  name: string;
  brief: string;
  blind: boolean;
  sourceProject?: string;
  rerunReceiptError?: boolean;
  msg: ClusterCreateFromScratchMessage;
  // REOPEN from the Research library (docs/RESEARCH.md).
  reopen?: { record: ResearchState; resumeDirectorId?: string };
}

export function researchMembersRoot(): string { return join(arcoHome(), 'research'); }

// Validates the research request and returns the rewritten creation message
// (folder as cwd, fixed roles, names and access modes), or a refusal code.
export async function prepareResearchCreate(msg: ClusterCreateFromScratchMessage, now = new Date()): Promise<PreparedResearch | { refusal: string }> {
  const spec = msg.research!;
  const name = typeof spec.name === 'string' ? spec.name.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > RESEARCH_NAME_MAX) return { refusal: 'invalid_name' };
  const brief = typeof spec.brief === 'string' ? spec.brief.trim() : '';
  if (!brief || brief.length > RESEARCH_BRIEF_MAX) return { refusal: 'invalid_brief' };
  const members = Array.isArray(msg.members) ? msg.members : [];
  if (members.length < 2) return { refusal: 'no_researchers' };
  if (members.length - 1 > RESEARCH_MAX_RESEARCHERS) return { refusal: 'too_many_researchers' };
  for (let i = 1; i < members.length; i++) {
    const refusal = researcherSpecRefusal(members[i]);
    if (refusal) return { refusal: `member[${i}] ${refusal}` };
  }
  const sandbox = await researcherSandboxRefusal(members.slice(1));
  if (sandbox) return { refusal: sandbox };
  let sourceProject: string | undefined;
  if (spec.sourceProject !== undefined) {
    if (typeof spec.sourceProject !== 'string' || !isAbsolute(spec.sourceProject)) return { refusal: 'invalid_source_project' };
    try { assertSafePath(spec.sourceProject); sourceProject = await fs.realpath(spec.sourceProject); assertSafePath(sourceProject); if (!(await fs.stat(sourceProject)).isDirectory()) return { refusal: 'invalid_source_project' }; }
    catch { return { refusal: 'invalid_source_project' }; }
  }
  if (spec.rerunFrom !== undefined && (typeof spec.rerunFrom !== 'string' || !UUID.test(spec.rerunFrom) || !await loadResearch(spec.rerunFrom))) return { refusal: 'invalid_rerun_source' };
  if (spec.quick !== undefined && typeof spec.quick !== 'boolean') return { refusal: 'invalid_quick' };
  const projectId = randomUUID();
  let folder: string;
  if (spec.quick) {
    const root = await ensureStorageRoot(join(arcoHome(), 'chat-workspaces'));
    folder = join(root, projectId);
    await fs.mkdir(folder, { mode: 0o700 });
    try {
      for (const sub of ['rounds', 'syntheses', 'sources']) await fs.mkdir(join(folder, sub), { mode: 0o700 });
    } catch (error) {
      await fs.rm(folder, { recursive: true, force: true });
      throw error;
    }
  } else {
    const settings = await readSettings();
    const requested = typeof spec.folderRoot === 'string' ? spec.folderRoot.trim() : '';
    if (requested && !isAbsolute(requested)) return { refusal: 'invalid_research_folder' };
    const root = settings.researchFolder ?? requested;
    if (!root) return { refusal: 'research_folder_required' };
    if (!settings.researchFolder) await patchSettings({ researchFolder: root });
    folder = await createResearchFolder(root, name, now);
  }
  const membersCwd = join(researchMembersRoot(), projectId);
  await fs.mkdir(membersCwd, { recursive: true, mode: 0o700 });
  const blind = spec.blind !== false;
  return {
    projectId, ...(spec.quick ? { quick: true } : {}), folder, membersCwd, name, brief, blind, ...(sourceProject ? { sourceProject } : {}),
    msg: {
      ...msg,
      cwd: folder,
      name: `Research: ${name}`,
      taskBoardMode: 'none',
      members: members.map((m, i) => i === 0
        ? { ...m, webSearchMaxUses: undefined, contextSize: undefined, role: RESEARCH_DIRECTOR_ROLE, displayName: RESEARCH_DIRECTOR_ROLE, accessMode: 'standard' as const, tier: undefined, focus: undefined }
        : researcherMemberSpec(m, researchLetter(i - 1))),
    },
  };
}

type ResearcherRow = ClusterCreateFromScratchMessage['members'][number];

// One researcher row as the start dialog and ADD RESEARCHER send it.
export function researcherSpecRefusal(m: ResearcherRow): string | undefined {
  if (!isResearcherProvider(m.provider)) return `researcher_provider_unavailable:${String(m.provider)}`;
  if (m.webAccess !== undefined && typeof m.webAccess !== 'boolean') return 'invalid_web_access';
  if (m.researchClaudeTransport !== undefined && (m.provider !== 'claude'
    || !['native', 'cli'].includes(m.researchClaudeTransport))) return 'invalid_research_transport';
  const { webSearchMaxUses: web, contextSize: ctx } = m;
  if (m.researchClaudeTransport === 'cli' && web !== undefined) return 'cli_web_search_limit_unsupported';
  if (web !== undefined && (!Number.isInteger(web) || web < 1 || web > 50)) return 'invalid_web_search_limit';
  if (ctx !== undefined && (!Number.isInteger(ctx) || ctx < 2048 || ctx > 1_048_576)) return 'invalid_context_size';
  return undefined;
}

// The sandbox each sandboxed provider among the rows needs.
export async function researcherSandboxRefusal(rows: ResearcherRow[]): Promise<string | undefined> {
  if (rows.some((m) => m.researchClaudeTransport === 'cli') && !await researchSandboxAvailable('claude')) return 'claude_research_sandbox_unavailable';
  if (rows.some((m) => m.provider === 'cursor')) {
    const reason = cursorIsolationReason();
    if (reason) return reason;
    if (!await researchSandboxAvailable('cursor')) return 'cursor_research_sandbox_unavailable';
  }
  // docs/RESEARCH.md "Gemini researchers": fenced only, with the separate research sign-in.
  if (rows.some((m) => m.provider === 'antigravity-cli')) {
    if (!await researchSandboxAvailable('antigravity')) return 'gemini_research_sandbox_unavailable';
    if (await geminiResearchSignInState() !== 'ready') return 'gemini_research_sign_in_needed';
  }
  if (rows.some((m) => m.provider === 'codex')) {
    const reason = codexResearchVersionReason(installedCodexVersion());
    if (reason) return reason;
    if (!await researchSandboxAvailable('codex')) return 'codex_research_sandbox_unavailable';
  }
  return undefined;
}

// The member a researcher row becomes: fixed name, role and access.
export function researcherMemberSpec(m: ResearcherRow, letter: string): ResearcherRow {
  return { provider: m.provider, model: m.model, effort: m.effort, providerAccountRef: m.providerAccountRef,
    role: RESEARCHER_ROLE, displayName: researcherName(letter), accessMode: 'researcher' as const,
    ...(m.webAccess === false ? { webAccess: false } : {}),
    ...(m.provider === 'claude' && m.researchClaudeTransport ? { researchClaudeTransport: m.researchClaudeTransport } : {}),
    ...(m.provider === 'claude' && m.webSearchMaxUses ? { webSearchMaxUses: m.webSearchMaxUses } : {}),
    ...(m.provider === 'ollama' && m.contextSize ? { contextSize: m.contextSize } : {}) };
}

// A research request refused after prepareResearchCreate made its folder:
// removes the folder and the members folder only while they are still
// empty (non-recursive removal, so nothing with content is ever deleted).
export async function discardUnusedResearchFolder(prepared: Pick<PreparedResearch, 'folder' | 'membersCwd'>): Promise<boolean> {
  await fs.rmdir(prepared.membersCwd).catch(() => undefined);
  try {
    for (const sub of await fs.readdir(prepared.folder)) {
      if (!['rounds', 'syntheses', 'sources'].includes(sub)) return false;
    }
    for (const sub of ['rounds', 'syntheses', 'sources']) {
      await fs.rmdir(join(prepared.folder, sub)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
    await fs.rmdir(prepared.folder);
    return true;
  } catch { return false; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// docs/RESEARCH.md - REOPEN: the project comes back in its own folder with
// new researchers whose letters continue after the earlier ones. With
// `resumeDirector` the saved Research Director conversation rejoins;
// members[0] then takes its saved provider and model.
export async function prepareResearchReopen(msg: ClusterCreateFromScratchMessage, liveClusters: Map<string, string>): Promise<PreparedResearch | { refusal: string }> {
  const reopen = msg.research?.reopen;
  if (!reopen || typeof reopen.projectId !== 'string' || !UUID.test(reopen.projectId) || typeof reopen.resumeDirector !== 'boolean') return { refusal: 'invalid_reopen' };
  const source = await reopenSource(reopen.projectId, liveClusters);
  if ('reason' in source) return { refusal: `research_reopen_unavailable: ${source.reason}` };
  const { record } = source;
  const members = Array.isArray(msg.members) ? msg.members : [];
  if (members.length < 2) return { refusal: 'no_researchers' };
  if (record.researchers.length + members.length - 1 > RESEARCH_MAX_RESEARCHERS) return { refusal: 'too_many_researchers' };
  for (let i = 1; i < members.length; i++) {
    const refusal = researcherSpecRefusal(members[i]);
    if (refusal) return { refusal: `member[${i}] ${refusal}` };
  }
  const sandbox = await researcherSandboxRefusal(members.slice(1));
  if (sandbox) return { refusal: sandbox };
  let director = members[0];
  let resumeDirectorId: string | undefined;
  if (reopen.resumeDirector) {
    const meta = await readMeta(record.folder, record.directorWorkflowId).catch(() => null);
    if (!meta) return { refusal: 'director_conversation_missing' };
    resumeDirectorId = record.directorWorkflowId;
    director = { provider: meta.primaryProvider as ClusterMemberProvider, model: String(meta.primaryModel ?? ''), ...(meta.primaryEffort ? { effort: meta.primaryEffort } : {}) } as typeof director;
  }
  const membersCwd = join(researchMembersRoot(), record.projectId);
  await fs.mkdir(membersCwd, { recursive: true, mode: 0o700 });
  const first = record.researchers.length;
  return {
    projectId: record.projectId, folder: record.folder, membersCwd, name: record.name, brief: record.brief, blind: record.blind,
    reopen: { record, ...(resumeDirectorId ? { resumeDirectorId } : {}) },
    msg: {
      ...msg,
      cwd: record.folder,
      name: `Research: ${record.name}`,
      taskBoardMode: 'none',
      members: [
        { ...director, webSearchMaxUses: undefined, contextSize: undefined, role: RESEARCH_DIRECTOR_ROLE, displayName: RESEARCH_DIRECTOR_ROLE, accessMode: 'standard' as const, tier: undefined, focus: undefined },
        ...members.slice(1).map((m, i) => researcherMemberSpec(m, researchLetter(first + i))),
      ],
    },
  };
}

// Restores the research state from the kept record. The earlier researchers
// stay for the records, marked removed at the close; a round that was open
// at the close is released with the replies that had arrived.
export async function finishResearchReopen(prepared: PreparedResearch, clusterId: string, workflowIds: string[], now = new Date()): Promise<{ state: ResearchState; released: number[] }> {
  const record = prepared.reopen!.record;
  const at = now.toISOString();
  const state: ResearchState = structuredClone(record);
  const closedAt = record.closedAt ?? at;
  delete state.closedAt;
  state.clusterId = clusterId;
  state.folder = prepared.folder;
  state.membersCwd = prepared.membersCwd;
  state.reopenedAt = at;
  state.directorWorkflowId = workflowIds[0];
  for (const r of state.researchers) {
    if (!r.removedAt) r.removedAt = closedAt;
    delete r.signInNeeded; delete r.signInRemainingMs;
  }
  const released: ResearchRound[] = [];
  for (const round of [...state.rounds, ...(state.catchUps ?? [])]) {
    if (round.releasedAt) continue;
    for (const entry of Object.values(round.entries)) {
      delete entry.deferred;
      if (entry.state === 'waiting') Object.assign(entry, { state: 'stopped', at, reason: 'The project was closed before this researcher replied.' });
    }
    round.releasedAt = at;
    released.push(round);
  }
  const fromRound = state.rounds.length + 1;
  state.researchers.push(...prepared.msg.members.slice(1).map((m, i) => ({
    workflowId: workflowIds[i + 1],
    letter: researchLetter(record.researchers.length + i),
    provider: m.provider as ClusterMemberProvider,
    model: m.model,
    ...(m.effort ? { effort: String(m.effort) } : {}),
    ...(m.provider === 'claude' && m.researchClaudeTransport ? { claudeTransport: m.researchClaudeTransport } : {}),
    joinedAt: at,
    joinedFromRound: fromRound,
  })));
  await initResearch(state);
  for (const round of released) await writeReleasedRound(state, round);
  await writeProjectFiles(state);
  await addToLibrary({ projectId: state.projectId, folder: state.folder, name: state.name, createdAt: state.createdAt });
  return { state, released: released.map((r) => r.n) };
}

export async function finishResearchCreate(prepared: PreparedResearch, clusterId: string, workflowIds: string[]): Promise<ResearchState> {
  const state: ResearchState = {
    schemaVersion: 1,
    projectId: prepared.projectId,
    ...(prepared.quick ? { quick: true } : {}),
    clusterId,
    folder: prepared.folder,
    membersCwd: prepared.membersCwd,
    ...(prepared.sourceProject ? { sourceProject: prepared.sourceProject } : {}),
    name: prepared.name,
    brief: prepared.brief,
    blind: prepared.blind,
    createdAt: new Date().toISOString(),
    directorWorkflowId: workflowIds[0],
    researchers: prepared.msg.members.slice(1).map((m, i) => ({
      workflowId: workflowIds[i + 1],
      letter: researchLetter(i),
      provider: m.provider as ClusterMemberProvider,
      model: m.model,
      ...(m.effort ? { effort: String(m.effort) } : {}),
      ...(m.provider === 'claude' && m.researchClaudeTransport ? { claudeTransport: m.researchClaudeTransport } : {}),
    })),
    rounds: [],
    targetedBeforeRounds: [],
  };
  await initResearch(state);
  await writeInitialFiles(state);
  if (prepared.msg.research?.rerunFrom) {
    const source = await loadResearch(prepared.msg.research.rerunFrom);
    if (source) { try { await recordResearchExport(source, { kind: 'project' }, `rerun as research project ${state.projectId}`); } catch { prepared.rerunReceiptError = true; } }
    else prepared.rerunReceiptError = true;
  }
  await addToLibrary({ projectId: state.projectId, folder: state.folder, name: state.name, createdAt: state.createdAt })
    .catch((error) => console.error('[arco] research library entry could not be written:', error));
  return state;
}
