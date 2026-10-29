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
  source: string;
  inline?: { content: string; language?: string };
}

export interface OutputSavedMessage {
  type: 'output_saved'; workflowId: string; path: string; sourcePath?: string; ts: number;
}
