import { workflows } from '../server/state.js';
import { rememberHistoryToolSupport } from '../handoffHistorySupport.js';
import { PORT } from '../server/constants.js';
import type { WorkerConfig } from '@arco/shared';
import { HANDOFF_HISTORY_CONTEXT } from '../handoffHistoryProtocol.js';
import { mintHandoffHistoryCapability } from '../http/handoffHistoryRoutes.js';
import { attachHandoffHistoryToken } from '../mcp/mcpConfigWriter.js';

type Binding = { token: string; port: number };
const bindings = new WeakMap<object, Binding>();
const prompts = new WeakMap<object, { base: string | undefined; applied: string }>();
export const historyBinding = (config: object): Binding | undefined => bindings.get(config);
/** Trusted launch path only: no caller identity or capability comes from a model. */
export async function prepareProviderHistory(config: WorkerConfig, options: { toolsSupported?: boolean } = {}): Promise<void> {
 bindings.delete(config);
 const previous = prompts.get(config);
 if (previous && config.appendSystemPrompt === previous.applied) config.appendSystemPrompt = previous.base;
 prompts.delete(config);
 const owner = config.workflowId ? workflows.get(config.workflowId) : undefined;
 if (owner && options.toolsSupported !== undefined) rememberHistoryToolSupport(owner, config.model ?? '', options.toolsSupported);
 if (options.toolsSupported === false) return;
 if (!config.workflowId || !config.cwd || config.ollamaFormat || config.interactionMode === 'chat' || config.incognito
  || (config.clusterAccessMode && config.clusterAccessMode !== 'standard')
  || (config.tools && !config.tools.includes('handoff_history'))) return;
 const token = await mintHandoffHistoryCapability(config.workflowId);
 if (!token) return;
 const port = PORT;
 if ((config.provider ?? 'claude') === 'claude') {
  config.clusterMcpConfigPath = await attachHandoffHistoryToken(config.cwd, config.workflowId, config.clusterMcpConfigPath, {
   port, planToolsCwd: config.cwd, handoffHistoryToken: token,
   clusterId: config.clusterId, taskBoardAttached: config.clusterTaskBoardAttached,
   accessMode: config.clusterAccessMode, registryServers: config.mcpRegistryServers,
   codebaseMemoryIndexPath: config.codebaseMemoryAttached ? config.codebaseMemoryIndexPath || config.cwd : undefined,
  });
 }
 bindings.set(config, { token, port });
 const base = config.appendSystemPrompt;
 config.appendSystemPrompt = [base, HANDOFF_HISTORY_CONTEXT].filter(Boolean).join('\n\n');
 prompts.set(config, { base, applied: config.appendSystemPrompt });
}
