// Storage warnings and the KEEP mark (P7.4, docs/STORAGE_PLAN.md).

// One large item in a conversation folder. `path` is relative to the
// conversation folder and uses `/`: a single artifact file, or `artifacts`
// for the conversation's whole artifacts folder when its total is large.
export interface StorageWarningItem {
  path: string;
  bytes: number;
  kind: 'file' | 'conversation';
}

// Sent (and logged) after a turn ends when an artifact file reaches the file
// threshold or a conversation's artifacts reach the conversation threshold.
// Each item warns once; approving it sets KEEP with reason `size-warning`,
// and a kept item never warns again.
export interface StorageWarningMessage {
  type: 'storage_warning';
  workflowId: string;
  items: StorageWarningItem[];
  fileThresholdBytes: number;
  conversationThresholdBytes: number;
}

// <project>/.arco/workflows/<id>/keep.json. Archive, delete, EMPTY SCRATCH
// and size warnings skip kept items. A kept path covers everything below it;
// "." keeps the whole conversation.
export interface KeepItem {
  path: string;
  reason: 'operator' | 'size-warning';
  at: number;
}
export interface KeepFile {
  version: 1;
  items: KeepItem[];
}
