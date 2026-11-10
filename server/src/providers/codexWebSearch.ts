import type { WorkerConfig } from '@arco/shared';

export function codexWebSearchMode(config: WorkerConfig): 'live' | 'disabled' {
  return config.interactionMode !== 'chat' || config.chatWebAccess ? 'live' : 'disabled';
}
