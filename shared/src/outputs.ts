export type OutputCategory = 'images' | 'documents' | 'audio' | 'video' | 'other';
export interface WorkflowOutput {
  id: string;
  workflowId: string;
  cwd: string;
  producer: string;
  title: string;
  name: string;
  category: OutputCategory;
  path?: string;
  originPath?: string;
  derivedFrom?: string;
  inputPath?: string;
  createdAt: number;
  updatedAt: number;
  size?: number;
  missing: boolean;
  // True for things made for the operator: generated media, documents at the top
  // of the artifacts folder, reports and exports. False for code edits and files
  // in artifact subfolders, which the Outputs panel shows under All files.
  primary?: boolean;
  source: string;
  inline?: { content: string; language?: string };
}

export interface OutputSavedMessage {
  type: 'output_saved'; workflowId: string; path: string; sourcePath?: string; ts: number;
}
