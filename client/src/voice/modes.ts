export type VoiceMode = 'archon' | 'conversation';

// Global, explicit switches run before either mode interprets the body. Keep
// quoted discussion of a switch from becoming a switch itself.
export function voiceModeSwitch(text: string): { mode: VoiceMode; body: string } | null {
  const chat = text.match(/^(?:let['’]?s (?:talk|spitball|brainstorm)|let us (?:talk|spitball|brainstorm)|conversation mode|talk to me)(?=$|[\s,:;.!?])[\s,:;.!?]*(?:about\s+)?/i);
  if (chat) return { mode: 'conversation', body: text.slice(chat[0].length).trim() };
  const control = text.match(/^(?:back to (?:arco|archon)|return to (?:arco|archon)|(?:arco|archon) mode|control mode)(?=$|[\s,:;.!?])[\s,:;.!?]*/i);
  return control ? { mode: 'archon', body: text.slice(control[0].length).trim() } : null;
}
