// Cluster presets — operator-saved cluster member templates persisted at
// ~/.archon/cluster-presets.json. CRUD through the three HTTP endpoints
// (GET / POST / DELETE /api/cluster-presets). Cwd is intentionally NOT
// part of a preset; the WorkflowCreator never threads cwd through this hook.

import { useCallback, useEffect, useState } from 'react';
import type { ClusterPreset, ClusterPresetMember } from '@archon/shared';

export interface SavePresetInput {
  name: string;
  clusterNameTemplate?: string;
  members: ClusterPresetMember[];
}

export interface UseClusterPresets {
  presets: ClusterPreset[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  save: (input: SavePresetInput) => Promise<ClusterPreset>;
  delete: (id: string) => Promise<void>;
}

export function useClusterPresets(): UseClusterPresets {
  const [presets, setPresets] = useState<ClusterPreset[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/cluster-presets');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const data = await res.json() as { presets: ClusterPreset[] };
      setPresets(Array.isArray(data.presets) ? data.presets : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const save = useCallback(async (input: SavePresetInput): Promise<ClusterPreset> => {
    const res = await fetch('/api/cluster-presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    const data = await res.json() as { preset: ClusterPreset };
    // Optimistically merge; refresh next render so the canonical
    // newest-first sort is honored without a round-trip race.
    setPresets((prev) => [data.preset, ...prev]);
    return data.preset;
  }, []);

  const del = useCallback(async (id: string): Promise<void> => {
    const res = await fetch(`/api/cluster-presets/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    setPresets((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return { presets, isLoading, error, refresh, save, delete: del };
}
