// The base system prompt and appended system prompt of one primary turn, put
// together from parts handleUserMessage (turnEngine.ts) has already gathered:
// the provider's own prompt and transcript replay, skills, the Chat or
// Computer preamble, CLAUDE.md and the knowledge base. Cluster, Genesis and
// public-project blocks are added after this, in turnEngine.ts. The order of
// the parts is what the model sees; pinned by turnPrompt.test.ts.

import { chatSystemPrompt } from '../chatMode.js';
import { withPreviewNudge } from '../server/prompts.js';
import { VOICE_OPERATOR_PROMPT } from '../voice/operatorPrompt.js';

export interface BasePromptParts {
  provider: string;
  chatMode: boolean;
  computerChat: boolean;
  chatWeb: boolean;
  // From the provider-specific replay step (local providers, incognito CLI).
  systemPrompt: string | undefined;
  appendSystemPrompt: string | undefined;
  // Standing pins and the skills manifest; empty strings when there are none.
  pinnedSkills: string;
  skillsManifest: string;
  // Discovered CLAUDE.md text (Claude tabs with project context), or null.
  claudeMd: string | null;
  // Always-include knowledge articles, or null.
  knowledge: string | null;
}

// Local HTTP transports take stable instructions in the provider's system
// prompt field; Claude and Codex fold them into the appended prompt.
export function usesSystemPromptField(provider: string): boolean {
  return provider === 'ollama' || provider === 'llamacpp' || provider === 'lmstudio' || provider === 'strata' || provider === 'deepseek';
}

export function composeBasePrompts(p: BasePromptParts): { systemPrompt: string | undefined; appendSystemPrompt: string | undefined } {
  const systemField = usesSystemPromptField(p.provider);
  const skills = [p.pinnedSkills, p.skillsManifest].filter(Boolean).join('\n\n');
  let systemPrompt = systemField && skills
    ? (p.systemPrompt ? `${skills}\n\n${p.systemPrompt}` : skills)
    : p.systemPrompt;
  const appendBase = p.chatMode ? p.appendSystemPrompt : withPreviewNudge(p.appendSystemPrompt);
  const baseWithSkills = !systemField && skills ? `${skills}\n\n${appendBase}` : appendBase;
  let append = baseWithSkills;
  // A Computer (voice) chat has its own instructions and real tools; the
  // generic Chat preamble would make the model refuse them.
  if (p.chatMode && p.computerChat) {
    if (systemField) systemPrompt = VOICE_OPERATOR_PROMPT;
    else if (p.provider !== 'codex') append = [VOICE_OPERATOR_PROMPT, append].filter(Boolean).join('\n\n');
  }
  if (p.chatMode && !p.computerChat) {
    const chatPrompt = chatSystemPrompt(p.chatWeb);
    if (systemField) systemPrompt = chatPrompt;
    else append = append ? `${chatPrompt}\n\n${append}` : chatPrompt;
  }
  // CLAUDE.md goes in front of the skills and transcript part.
  if (p.claudeMd) append = baseWithSkills ? `${p.claudeMd}\n\n${baseWithSkills}` : p.claudeMd;
  // The bounded knowledge block goes in front of everything so far.
  if (p.knowledge) append = append ? `${p.knowledge}\n\n${append}` : p.knowledge;
  return { systemPrompt, appendSystemPrompt: append };
}
