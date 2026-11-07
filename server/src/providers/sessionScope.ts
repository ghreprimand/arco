import type { WorkerConfig } from '@arco/shared';
import { UUID_PATTERN } from '../server/constants.js';

export function providerSessionScope(config: WorkerConfig): string | undefined {
  if (config.sessionScopeId !== undefined && !UUID_PATTERN.test(config.sessionScopeId)) {
    throw new Error('Auxiliary provider session scope must be a UUID');
  }
  return config.sessionScopeId ?? config.workflowId;
}
