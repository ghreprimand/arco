import type { WorkerConfig } from '@arco/shared';

export function codexWebSearchMode(config: WorkerConfig): 'live' | 'disabled' {
  return config.clusterWebAccess === false || (config.interactionMode === 'chat' && !config.chatWebAccess) ? 'disabled' : 'live';
}
