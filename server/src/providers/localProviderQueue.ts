// Shared local-provider slots for worker turns and bounded side jobs.
export type LocalProviderName = 'ollama' | 'llamacpp' | 'lmstudio' | 'strata' | 'deepseek';
const queues: Record<LocalProviderName, Promise<void>> = {
  ollama: Promise.resolve(), llamacpp: Promise.resolve(), lmstudio: Promise.resolve(),
  strata: Promise.resolve(), deepseek: Promise.resolve(),
};

export function queueLocalProvider<T>(provider: LocalProviderName, run: () => Promise<T>): Promise<T> {
  const prior = queues[provider];
  let release!: () => void;
  queues[provider] = new Promise<void>((resolve) => { release = resolve; });
  return prior.then(run, run).finally(release);
}
