export type LocalModelProvider = 'ollama' | 'strata' | 'deepseek' | 'llamacpp' | 'lmstudio';

export interface LocalModelUnloadOutcome {
  provider: LocalModelProvider;
  state: 'unloaded' | 'idle' | 'unavailable' | 'skipped' | 'failed';
  model?: string;
  detail?: string;
}

export interface LocalModelUnloadReport {
  results: LocalModelUnloadOutcome[];
  blocked?: boolean;
  error?: string;
}
