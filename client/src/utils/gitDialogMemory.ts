// Remembers an unsent GIT dialog per tab so closing it (for example through
// VIEW CHANGES in SHOW OTHER WORK) and reopening it finds the same choices.
// Held in memory only. Cleared when a commit request is sent or the tab closes.
export interface GitDialogMemory {
  action?: string;
  runAs?: unknown;
  saveAsDefault: boolean;
  commitSubject: string;
  scopeNotes: string;
  pickedBranch: string;
  creatingNew: boolean;
  newBranchName: string;
  newBranchBase: string;
  showDiff: boolean;
  otherOpen: boolean;
  scrollTop: number;
}

const memory = new Map<string, GitDialogMemory>();

export const recallGitDialog = (workflowId: string): GitDialogMemory | undefined => memory.get(workflowId);
export const rememberGitDialog = (workflowId: string, state: Partial<GitDialogMemory>): void => {
  const base: GitDialogMemory = memory.get(workflowId) ?? { saveAsDefault: false, commitSubject: '', scopeNotes: '', pickedBranch: '', creatingNew: false, newBranchName: '', newBranchBase: '', showDiff: false, otherOpen: false, scrollTop: 0 };
  memory.set(workflowId, { ...base, ...state });
};
export const forgetGitDialog = (workflowId: string): void => { memory.delete(workflowId); };
