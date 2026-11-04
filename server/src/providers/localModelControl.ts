import type { LocalModelProvider } from '@arco/shared';

export function isLocalModelProvider(provider?: string): provider is LocalModelProvider {
  return provider === 'ollama' || provider === 'strata' || provider === 'deepseek' || provider === 'llamacpp' || provider === 'lmstudio';
}

let operation: 'unload' | 'strata-switch' | 'deepseek-switch' | null = null;
export function localModelsUnloading(): boolean { return operation !== null; }
export function localModelBusyMessage(): string {
  return operation === 'strata-switch' || operation === 'deepseek-switch'
    ? `${operation === 'deepseek-switch' ? 'DeepSeek' : 'Strata'} is switching models. Retry when the model finishes loading.`
    : 'Local models are being unloaded. Retry when FREE VRAM finishes.';
}
function begin(kind: NonNullable<typeof operation>): (() => void) | null {
  if (operation) return null;
  operation = kind;
  return () => { operation = null; };
}
export function beginLocalModelUnload(): (() => void) | null { return begin('unload'); }
export function beginLocalModelSwitch(provider: 'strata' | 'deepseek' = 'strata'): (() => void) | null { return begin(`${provider}-switch`); }
