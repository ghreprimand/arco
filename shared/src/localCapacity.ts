// How many cluster members may use a local model runtime (Ollama, llama.cpp)
// at once. Each different model loads its own copy into memory; parallel
// requests to one loaded model share it. The runtime itself still decides what
// it accepts (for Ollama: OLLAMA_MAX_LOADED_MODELS and OLLAMA_NUM_PARALLEL).
// Default 1 keeps the historical rule: at most one local member per cluster.
// ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL=1 on the server lifts the limit entirely.

export type LocalClusterRuntime = 'ollama' | 'llamacpp';
export type LocalClusterCapacity = Partial<Record<LocalClusterRuntime, number>>;

export const LOCAL_CLUSTER_RUNTIMES: readonly LocalClusterRuntime[] = ['ollama', 'llamacpp'];
export const LOCAL_CLUSTER_CAPACITY_DEFAULT = 1;
export const LOCAL_CLUSTER_CAPACITY_MIN = 1;
export const LOCAL_CLUSTER_CAPACITY_MAX = 16;
export const LOCAL_RUNTIME_LABELS: Record<LocalClusterRuntime, string> = { ollama: 'Ollama', llamacpp: 'llama.cpp' };

export function isLocalClusterRuntime(provider: unknown): provider is LocalClusterRuntime {
  return provider === 'ollama' || provider === 'llamacpp';
}

export function sanitizeLocalClusterCapacity(raw: unknown): LocalClusterCapacity | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: LocalClusterCapacity = {};
  for (const runtime of LOCAL_CLUSTER_RUNTIMES) {
    const value = (raw as Record<string, unknown>)[runtime];
    if (typeof value === 'number' && Number.isInteger(value) && value >= LOCAL_CLUSTER_CAPACITY_MIN && value <= LOCAL_CLUSTER_CAPACITY_MAX) out[runtime] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function localClusterCapacityFor(capacity: LocalClusterCapacity | undefined, runtime: LocalClusterRuntime): number {
  return capacity?.[runtime] ?? LOCAL_CLUSTER_CAPACITY_DEFAULT;
}

export interface LocalCapacityUsage {
  runtime: LocalClusterRuntime;
  used: number;
  limit: number;
}

/** Per-runtime usage plus the combined local limit (the larger runtime setting). */
export function localCapacityUsage(providers: readonly unknown[], capacity: LocalClusterCapacity | undefined): { runtimes: LocalCapacityUsage[]; combinedUsed: number; combinedLimit: number } {
  const runtimes = LOCAL_CLUSTER_RUNTIMES.map((runtime) => ({
    runtime,
    used: providers.filter((p) => p === runtime).length,
    limit: localClusterCapacityFor(capacity, runtime),
  }));
  return {
    runtimes,
    combinedUsed: runtimes.reduce((sum, r) => sum + r.used, 0),
    combinedLimit: Math.max(...runtimes.map((r) => r.limit)),
  };
}

/**
 * Plain-language refusal when a cluster's members exceed local capacity, or
 * null. Each runtime is limited by its own setting; members on Ollama and
 * llama.cpp together are limited by the larger setting because both share
 * this machine's memory. With both settings at 1 this is the historical
 * one-local-member rule.
 */
export function localCapacityProblem(providers: readonly unknown[], capacity: LocalClusterCapacity | undefined, unlimited = false): string | null {
  if (unlimited) return null;
  const usage = localCapacityUsage(providers, capacity);
  for (const r of usage.runtimes) {
    if (r.used > r.limit) {
      return `${r.used} members use ${LOCAL_RUNTIME_LABELS[r.runtime]}, but it allows ${r.limit} at once. Raise "Cluster members that may use this runtime at once" in Connections > ${LOCAL_RUNTIME_LABELS[r.runtime]}, or choose another provider.`;
    }
  }
  if (usage.combinedUsed > usage.combinedLimit) {
    return `${usage.combinedUsed} members use local runtimes, but Ollama and llama.cpp together allow ${usage.combinedLimit} at once (the larger of their settings). Raise a runtime's setting in Connections, or choose another provider.`;
  }
  return null;
}
