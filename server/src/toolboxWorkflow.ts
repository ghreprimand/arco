import { effectiveClaudeTransport } from './claudeTransport.js';
import { isChatWorkflow } from './chatMode.js';
import * as clusterStore from './clusterStore.js';
import { isManagedBakeoffWorktree } from './gitBakeoff.js';
import { gateManagedWorktreeResources, gateProjectResources } from './projectTrust.js';
import { readSettings } from './settings.js';
import type { WorkflowState } from './workflows/types.js';

// Match turn-time transport resolution before offering a provider invocation.
// In particular, project settings only apply if the project trust gate allows
// them, and Chat and isolated workers do not expose the native skill runtime.
export async function toolboxWorkflowRuntime(workflowId: string, workflow: WorkflowState): Promise<{ provider: string; cwd: string; account?: string; transport?: string }> {
  let provider: string = workflow.primary.provider;
  const cwd = workflow.config.workingDirectory || process.cwd();
  const account = workflow.config.providerAccountRef;
  const clusterId = clusterStore.getClusterIdForWorkflow(workflowId);
  if (isChatWorkflow(workflow.config) || (clusterId && clusterStore.getMemberAccessMode(clusterId, workflowId) === 'isolated')) return { provider: '', cwd, account };
  let transport: string | undefined;
  if (provider === 'claude' || provider === 'codex') {
    const source = workflow.config.managedWorktreeSourceCwd;
    const managed = source && await isManagedBakeoffWorktree(source, cwd).catch(() => false);
    const gate = await (managed ? gateManagedWorktreeResources(cwd, source!) : gateProjectResources(cwd)).catch(() => ({ includeProject: false }));
    const settings = await readSettings(cwd, { includeProject: gate.includeProject }).catch(() => null);
    transport = provider === 'claude'
      ? effectiveClaudeTransport(workflow.config, settings)
      : workflow.config.codexTransport ?? (settings?.codex?.transport === 'appserver' ? 'appserver' : 'exec');
  }
  return { provider, cwd, account, transport };
}
