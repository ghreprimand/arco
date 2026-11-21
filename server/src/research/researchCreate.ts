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
    if (!isResearcherProvider(members[i].provider)) return { refusal: `member[${i}] researcher_provider_unavailable:${String(members[i].provider)}` };
    const { webSearchMaxUses: web, contextSize: ctx } = members[i];
    if (web !== undefined && (!Number.isInteger(web) || web < 1 || web > 50)) return { refusal: `member[${i}] invalid_web_search_limit` };
    if (ctx !== undefined && (!Number.isInteger(ctx) || ctx < 2048 || ctx > 1_048_576)) return { refusal: `member[${i}] invalid_context_size` };
  }
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
        : { provider: m.provider, model: m.model, effort: m.effort, providerAccountRef: m.providerAccountRef,
            role: RESEARCHER_ROLE, displayName: researcherName(researchLetter(i - 1)), accessMode: 'researcher' as const,
            ...(m.provider === 'claude' && m.webSearchMaxUses ? { webSearchMaxUses: m.webSearchMaxUses } : {}),
            ...(m.provider === 'ollama' && m.contextSize ? { contextSize: m.contextSize } : {}) }),
    },
  };
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
    })),
    rounds: [],
    targetedBeforeRounds: [],
  };
  await initResearch(state);
  await writeInitialFiles(state);
  return state;
}
