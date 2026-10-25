// Voice is an operator input surface. Commands/audio are session-local;
// effects reuse the existing workflow messages and their persistence.
// A partial emoji is legal in JS strings/JSON, but not in Rust MCP strings.
// Bound text without splitting a pair, and repair malformed source text.
export function voiceText(text: string, limit = text.length): string {
  let clipped = text.slice(0, limit);
  if (clipped.length < text.length && /[\uD800-\uDBFF]$/.test(clipped)
      && /[\uDC00-\uDFFF]/.test(text[clipped.length])) clipped = clipped.slice(0, -1);
  return clipped.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}
export const VOICE_ACTIONS = [
  'navigate', 'member', 'panel', 'dictate', 'finish', 'send', 'steer', 'follow-up',
  'nudge', 'read', 'read-draft', 'scratch', 'clear-draft', 'new-paragraph',
  'status', 'back', 'quiet', 'disable', 'cancel-turn', 'help', 'choose', 'alias',
  'replace', 'scroll', 'global', 'literal', 'project-status', 'recent', 'dialog',
] as const;
export type VoiceAction = typeof VOICE_ACTIONS[number];
export interface VoiceCommand { action: VoiceAction; target: string; value: string }
export interface VoiceTarget {
  id: string;
  name: string;
  kind: 'workflow' | 'chat' | 'cluster' | 'member';
  clusterId?: string;
  role?: string;
  aliases?: string[];
}
export interface VoiceContext {
  targets: VoiceTarget[];
  currentId: string | null;
  clusterId: string | null;
}
export interface VoiceUsage { inputTokens: number; outputTokens: number; cachedInputTokens: number }
export interface VoiceInterpretResult { command: VoiceCommand; usage: VoiceUsage; model: string; effort: string }
export const VOICE_MAX_TEXT = 8_000;
export const VOICE_MAX_TARGETS = 80;
export function isVoiceCommand(value: unknown): value is VoiceCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return Object.keys(c).every((key) => ['action', 'target', 'value'].includes(key))
    && VOICE_ACTIONS.includes(c.action as VoiceAction)
    && typeof c.target === 'string' && c.target.length <= 160
    && typeof c.value === 'string' && c.value.length <= VOICE_MAX_TEXT;
}

// Output voices share the existing Edge speech path; none changes routing or
// microphone behavior. Keep the picker and server validation in one place.
// English female voices listed by Edge on 2026-10-17, grouped by accent.
export const VOICE_OUTPUT_OPTIONS = [
  { id: 'en-US-AnaNeural', name: 'Ana (child)', accent: 'American' },
  { id: 'en-US-AriaNeural', name: 'Aria', accent: 'American' },
  { id: 'en-US-AvaNeural', name: 'Ava', accent: 'American' },
  { id: 'en-US-AvaMultilingualNeural', name: 'Ava (multilingual)', accent: 'American' },
  { id: 'en-US-EmmaNeural', name: 'Emma', accent: 'American' },
  { id: 'en-US-EmmaMultilingualNeural', name: 'Emma (multilingual)', accent: 'American' },
  { id: 'en-US-JennyNeural', name: 'Jenny', accent: 'American' },
  { id: 'en-US-MichelleNeural', name: 'Michelle', accent: 'American' },
  { id: 'en-AU-NatashaNeural', name: 'Natasha', accent: 'Australian' },
  { id: 'en-GB-LibbyNeural', name: 'Libby', accent: 'British' },
  { id: 'en-GB-MaisieNeural', name: 'Maisie (child)', accent: 'British' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia', accent: 'British' },
  { id: 'en-CA-ClaraNeural', name: 'Clara', accent: 'Canadian' },
  { id: 'en-PH-RosaNeural', name: 'Rosa', accent: 'Filipino' },
  { id: 'en-HK-YanNeural', name: 'Yan', accent: 'Hong Kong' },
  { id: 'en-IN-NeerjaNeural', name: 'Neerja', accent: 'Indian' },
  { id: 'en-IN-NeerjaExpressiveNeural', name: 'Neerja (expressive)', accent: 'Indian' },
  { id: 'en-IE-EmilyNeural', name: 'Emily', accent: 'Irish' },
  { id: 'en-KE-AsiliaNeural', name: 'Asilia', accent: 'Kenyan' },
  { id: 'en-NZ-MollyNeural', name: 'Molly', accent: 'New Zealand' },
  { id: 'en-NG-EzinneNeural', name: 'Ezinne', accent: 'Nigerian' },
  { id: 'en-SG-LunaNeural', name: 'Luna', accent: 'Singaporean' },
  { id: 'en-ZA-LeahNeural', name: 'Leah', accent: 'South African' },
  { id: 'en-TZ-ImaniNeural', name: 'Imani', accent: 'Tanzanian' },
] as const;
export type VoiceOutputId = typeof VOICE_OUTPUT_OPTIONS[number]['id'];
export const DEFAULT_VOICE_OUTPUT = 'en-GB-SoniaNeural';
export const VOICE_OUTPUT_SAMPLE = 'Of course. Take your time. What would you like to do next?';
export const isVoiceOutputId = (value: unknown): value is VoiceOutputId =>
  VOICE_OUTPUT_OPTIONS.some((voice) => voice.id === value);
