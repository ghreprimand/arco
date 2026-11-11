import type { WorkflowState } from './workflows/types.js';
import { readSettings } from './settings.js';

// Effective Claude transport for a workflow: sticky ultracode forces 'cli'
// (the harness WorkflowTool lives only in the `claude` binary), else explicit
// per-tab config wins, else the cwd's TRANSPORT DEFAULTS cascade, else 'cli'.
// Same precedence as the turn dispatcher — keep the two in sync.
export function effectiveClaudeTransport(config: WorkflowState['config'], settings?: { claude?: { transport?: string } } | null): 'cli' | 'native' {
  return config.ultracode ? 'cli' : config.claudeTransport ?? (settings?.claude?.transport === 'native' ? 'native' : 'cli');
}
export async function resolveClaudeTransport(wf: WorkflowState, cwd?: string): Promise<'cli' | 'native'> {
  if (wf.config.ultracode || wf.config.claudeTransport) return effectiveClaudeTransport(wf.config);
  return effectiveClaudeTransport(wf.config, await readSettings(cwd).catch(() => null));
}
