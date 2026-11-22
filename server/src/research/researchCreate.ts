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
import { arcoHome } from '../arcoHome.js';
import { patchSettings, readSettings } from '../settings.js';
import { researchSandboxAvailable } from '../workers/researchSandboxAvailability.js';
import { cursorIsolationReason } from '../providers/cursor/isolatedVersion.js';
import { codexResearchVersionReason, installedCodexVersion } from '../providers/codexVersion.js';
import { createResearchFolder, writeInitialFiles } from './researchFolder.js';
import { initResearch, researchLetter, researcherName, type ResearchState } from './researchState.js';

export const RESEARCH_DIRECTOR_ROLE = 'Research Director';
export const RESEARCHER_ROLE = 'Researcher';
export const RESEARCH_NAME_MAX = 60;
export const RESEARCH_BRIEF_MAX = 20_000;

export interface PreparedResearch {
  projectId: string;
  folder: string;
  membersCwd: string;
  name: string;
  brief: string;
  blind: boolean;
  msg: ClusterCreateFromScratchMessage;
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
  const settings = await readSettings();
  const requested = typeof spec.folderRoot === 'string' ? spec.folderRoot.trim() : '';
  if (requested && !isAbsolute(requested)) return { refusal: 'invalid_research_folder' };
  const root = settings.researchFolder ?? requested;
  if (!root) return { refusal: 'research_folder_required' };
  if (!settings.researchFolder) await patchSettings({ researchFolder: root });
  const folder = await createResearchFolder(root, name, now);
  const projectId = randomUUID();
  const membersCwd = join(researchMembersRoot(), projectId);
  await fs.mkdir(membersCwd, { recursive: true, mode: 0o700 });
  const blind = spec.blind !== false;
  return {
    projectId, folder, membersCwd, name, brief, blind,
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

export async function finishResearchCreate(prepared: PreparedResearch, clusterId: string, workflowIds: string[]): Promise<ResearchState> {
  const state: ResearchState = {
    schemaVersion: 1,
    projectId: prepared.projectId,
    clusterId,
    folder: prepared.folder,
    membersCwd: prepared.membersCwd,
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
  return state;
}
