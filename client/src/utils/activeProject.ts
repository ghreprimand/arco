import type { AppState } from '../stores/appStore.types';

export function activeProjectCwd(state: Pick<AppState, 'activeJobId' | 'activeClusterId' | 'jobs' | 'clusters'>): string {
  if (state.activeClusterId) return state.clusters[state.activeClusterId]?.cwd ?? '';
  return state.activeJobId ? state.jobs[state.activeJobId]?.config.workingDirectory ?? '' : '';
}
