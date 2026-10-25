import { create } from 'zustand';
import { isVoiceOutputId, type VoiceOutputId, type VoiceCommand, type VoiceUsage } from '@archon/shared';
import type { VoiceMode } from './modes';

const OUTPUT_KEY = 'archon.voice.output.v1';
function savedOutputVoice(): VoiceOutputId | null {
  try { const value = localStorage.getItem(OUTPUT_KEY); return isVoiceOutputId(value) ? value : null; }
  catch { return null; }
}
// Output and sensitivity preferences survive reload. Never persist microphone state.
export const useVoiceStore = create<{
  speechThreshold: number;
  setSpeechThreshold: (value: number) => void;
  outputVoice: VoiceOutputId | null;
  setOutputVoice: (voice: VoiceOutputId | null) => void;
  open: boolean;
  enabled: boolean;
  mode: VoiceMode;
  phase: 'off' | 'starting' | 'listening' | 'recognizing' | 'interpreting' | 'speaking';
  status: string;
  error: string | null;
  inputLevel: number;
  lastHeard: string;
  dictatingId: string | null;
  draftId: string | null;
  spokenFeedback: boolean;
  lunaEnabled: boolean;
  calls: number;
  usage: VoiceUsage;
  choices: Array<{ id: string; name: string }>;
  pendingCommand: VoiceCommand | null;
  commandText: string | null;
  recognizer: string;
  recognitionMs: number | null;
  interpretationMs: number | null;
  speechMs: number | null;
  endpointMs: number | null;
  noiseFloor: number | null;
  speechOnset: number | null;
}>((set) => ({ speechThreshold: (() => {
  try { const n = Number(localStorage.getItem('archon.voice.threshold.v1')); return n >= .001 && n <= .01 ? n : .0035; } catch { return .0035; }
})(), setSpeechThreshold: (value) => {
  if (!Number.isFinite(value) || value < .001 || value > .01) return;
  try { localStorage.setItem('archon.voice.threshold.v1', String(value)); } catch {}
  set({ speechThreshold: value });
}, outputVoice: savedOutputVoice(), setOutputVoice: (voice) => {
  if (voice !== null && !isVoiceOutputId(voice)) return;
  try { if (voice === null) localStorage.removeItem(OUTPUT_KEY); else localStorage.setItem(OUTPUT_KEY, voice); } catch {}
  set({ outputVoice: voice });
}, open: false, enabled: false, mode: 'archon', phase: 'off', status: 'Microphone off.', error: null,
  inputLevel: 0, lastHeard: '', dictatingId: null, draftId: null, spokenFeedback: true, lunaEnabled: true,
  calls: 0, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, choices: [], pendingCommand: null, commandText: null,
  recognizer: '', recognitionMs: null, interpretationMs: null, speechMs: null, endpointMs: null, noiseFloor: null, speechOnset: null }));

