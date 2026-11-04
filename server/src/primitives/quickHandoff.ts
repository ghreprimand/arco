import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ServerMessage } from '@arco/shared';
import { renderTranscript, summarizePriorTurns } from './exportContext.js';

const exec = promisify(execFile);

// A byte per token is a conservative bound for UTF-8 text. The total seed is
// capped at 20% of the known context, including git facts and the action digest.
// An unknown window uses 4096 tokens instead of assuming the old model's size.
function tail(text: string, bytes: number): string {
  const data = Buffer.from(text, 'utf8');
  if (data.length <= bytes) return text;
  if (bytes <= 0) return '';
  return data.subarray(data.length - bytes).toString('utf8').replace(/^\uFFFD+/, '');
}

function head(text: string, bytes: number): string {
  const data = Buffer.from(text, 'utf8');
  if (data.length <= bytes) return text;
  if (bytes <= 0) return '';
  const marker = '[truncated]';
  if (bytes <= marker.length) return marker.slice(0, bytes);
  return data.subarray(0, bytes - marker.length).toString('utf8').replace(/\uFFFD+$/, '') + marker;
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await exec('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, timeout: 2500, maxBuffer: 64 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    return result.stdout.trim();
  } catch { return '(unavailable)'; }
}

export async function buildQuickHandoff(cwd: string, events: ServerMessage[], windowTokens?: number): Promise<string> {
  const window = Number.isFinite(windowTokens) && windowTokens! > 0 ? Math.floor(windowTokens!) : 4096;
  const budget = Math.max(1, Math.floor(window * 0.2));
  if (budget < 256) throw new Error('The selected context window is too small for a quick handoff.');
  const [branch, status, log] = await Promise.all([
    git(cwd, ['branch', '--show-current']),
    git(cwd, ['status', '--short', '--untracked-files=normal']),
    git(cwd, ['log', '-5', '--oneline']),
  ]);
  const header = `# Quick handoff\n\nDeterministic context, bounded to 20% of a ${window}-token window (one UTF-8 byte per estimated token). Earlier material may be omitted.\n`;
  const factBudget = Math.floor(budget * 0.35);
  const facts = `\n## Git state\nBranch: ${head(branch || '(detached)', Math.floor(factBudget * 0.15))}\nStatus:\n${head(status || '(clean)', Math.floor(factBudget * 0.4))}\nRecent commits:\n${head(log, Math.floor(factBudget * 0.3))}\n`;
  const transcript = renderTranscript(events).trim();
  const digest = summarizePriorTurns(events).trim();
  const labels = '\n## Recent conversation\n\n## Prior-turn action digest\n';
  const fixed = tail(facts, Math.max(0, budget - Buffer.byteLength(header + labels, 'utf8')));
  const available = Math.max(0, budget - Buffer.byteLength(header + fixed + labels, 'utf8'));
  return `${header}${fixed}\n## Recent conversation\n${tail(transcript, Math.floor(available * 0.7))}\n## Prior-turn action digest\n${tail(digest, Math.floor(available * 0.3))}`.trim();
}
