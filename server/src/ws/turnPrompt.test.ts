import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatSystemPrompt } from '../chatMode.js';
import { withPreviewNudge } from '../server/prompts.js';
import { VOICE_OPERATOR_PROMPT } from '../voice/operatorPrompt.js';
import { composeBasePrompts, usesSystemPromptField, type BasePromptParts } from './turnPrompt.js';

// The order of the base prompt parts, per provider kind and mode.

const parts = (over: Partial<BasePromptParts> = {}): BasePromptParts => ({ provider: 'claude', chatMode: false, computerChat: false, chatWeb: false, systemPrompt: undefined, appendSystemPrompt: undefined, pinnedSkills: '', skillsManifest: '', claudeMd: null, knowledge: null, ...over });
const NUDGE = withPreviewNudge(undefined);

test('which providers take instructions in the system prompt field', () => {
  assert.deepEqual(['ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek', 'claude', 'codex', 'cursor'].map(usesSystemPromptField), [true, true, true, true, true, false, false, false]);
});

test('Claude agent turn: knowledge, CLAUDE.md, skills, then the preview note and the replay', () => {
  assert.deepEqual(composeBasePrompts(parts()), { systemPrompt: undefined, appendSystemPrompt: NUDGE });
  assert.deepEqual(composeBasePrompts(parts({ appendSystemPrompt: 'REPLAY', pinnedSkills: 'PINS', skillsManifest: 'MANIFEST', claudeMd: 'CLAUDE.MD', knowledge: 'KB' })),
    { systemPrompt: undefined, appendSystemPrompt: `KB\n\nCLAUDE.MD\n\nPINS\n\nMANIFEST\n\n${NUDGE}\n\nREPLAY` });
});

test('local provider agent turn: skills before the provider prompt in the system field', () => {
  assert.deepEqual(composeBasePrompts(parts({ provider: 'ollama', systemPrompt: 'OLLAMA', appendSystemPrompt: 'REPLAY', skillsManifest: 'MANIFEST', knowledge: 'KB' })),
    { systemPrompt: 'MANIFEST\n\nOLLAMA', appendSystemPrompt: `KB\n\n${NUDGE}\n\nREPLAY` });
  assert.deepEqual(composeBasePrompts(parts({ provider: 'llamacpp', pinnedSkills: 'PINS' })).systemPrompt, 'PINS');
});

test('Chat turns: the Chat preamble replaces the system prompt or leads the appended one; no preview note', () => {
  assert.deepEqual(composeBasePrompts(parts({ provider: 'ollama', chatMode: true, chatWeb: true, systemPrompt: 'OLLAMA', appendSystemPrompt: 'REPLAY' })),
    { systemPrompt: chatSystemPrompt(true), appendSystemPrompt: 'REPLAY' });
  assert.deepEqual(composeBasePrompts(parts({ provider: 'codex', chatMode: true, appendSystemPrompt: 'REPLAY' })),
    { systemPrompt: undefined, appendSystemPrompt: `${chatSystemPrompt(false)}\n\nREPLAY` });
  assert.deepEqual(composeBasePrompts(parts({ chatMode: true })), { systemPrompt: undefined, appendSystemPrompt: chatSystemPrompt(false) });
});

test('Computer chats get their own instructions; Codex carries them elsewhere', () => {
  assert.deepEqual(composeBasePrompts(parts({ provider: 'lmstudio', chatMode: true, computerChat: true, systemPrompt: 'BASE', appendSystemPrompt: 'HISTORY' })),
    { systemPrompt: VOICE_OPERATOR_PROMPT, appendSystemPrompt: 'HISTORY' });
  assert.deepEqual(composeBasePrompts(parts({ chatMode: true, computerChat: true, appendSystemPrompt: 'HISTORY' })),
    { systemPrompt: undefined, appendSystemPrompt: `${VOICE_OPERATOR_PROMPT}\n\nHISTORY` });
  assert.deepEqual(composeBasePrompts(parts({ provider: 'codex', chatMode: true, computerChat: true, appendSystemPrompt: 'HISTORY' })),
    { systemPrompt: undefined, appendSystemPrompt: 'HISTORY' });
});
