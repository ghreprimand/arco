import type { JobState } from '../stores/appStore';
import { formatTokPerSec, tokensPerSecond } from '../utils/format';

// Engine timings exclude network/tool time. Count and duration sums keep
// short tool-call rounds from dominating a multi-round turn's rate.
export function GenerationSpeedReadout({ job }: { job: Pick<JobState, 'config' | 'lastGenSpeed'> }) {
  const s = job.lastGenSpeed;
  const provider = job.config.primaryProvider;
  if (!s || (provider !== 'ollama' && provider !== 'strata' && provider !== 'deepseek')) return null;
  const decode = tokensPerSecond(s.decodeTokens, s.decodeMs);
  const prefill = tokensPerSecond(s.prefillTokens, s.prefillMs);
  if (decode === null && prefill === null) return null;
  const engine = provider === 'deepseek' ? 'Xolotl engine' : provider === 'strata' ? 'Strata engine' : 'Ollama daemon';
  const hover = [
    `Last turn — measured by the ${engine} (summed across the turn's tool loop)`,
    decode !== null ? `Decode: ${formatTokPerSec(decode)} tok/s (${s.decodeTokens.toLocaleString()} tokens in ${(s.decodeMs / 1000).toFixed(2)}s)` : '',
    prefill !== null ? `Prefill: ${formatTokPerSec(prefill)} tok/s (${s.prefillTokens.toLocaleString()} tokens in ${(s.prefillMs / 1000).toFixed(2)}s)` : '',
    'Prefill counts only newly processed tokens; cached prompt prefix is excluded.',
  ].filter(Boolean).join('\n');
  return <>
    <span style={{ color: 'var(--color-fg-muted)', opacity: 0.6 }}>·</span>
    <span data-help="composer.footer.speed" title={hover} style={{ color: 'var(--color-fg-muted)', opacity: 0.8, whiteSpace: 'nowrap' }}>
      {decode !== null ? `⚡ ${formatTokPerSec(decode)} tok/s` : ''}
      {decode !== null && prefill !== null ? ' · ' : ''}
      {prefill !== null ? `PP ${formatTokPerSec(prefill)}` : ''}
    </span>
  </>;
}
