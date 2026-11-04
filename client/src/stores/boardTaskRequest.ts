import { create } from 'zustand';

// One-shot request to open a cluster's BOARD sub-tab and select a task. The
// Needs-you popover sets it; ClusterRightPanel switches tabs, and
// ClusterTaskBoardTab consumes (clears) it once it has selected the task.
export interface BoardTaskRequest {
  clusterId: string;
  taskId: string;
  seq: number;
}

export const useBoardTaskRequest = create<{ request: BoardTaskRequest | null }>(() => ({ request: null }));

export function requestBoardTask(clusterId: string, taskId: string): void {
  useBoardTaskRequest.setState((s) => ({ request: { clusterId, taskId, seq: (s.request?.seq ?? 0) + 1 } }));
}

export function clearBoardTaskRequest(): void {
  useBoardTaskRequest.setState((s) => (s.request ? { request: null } : s));
}
