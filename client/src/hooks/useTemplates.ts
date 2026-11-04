// Workbench Expansion §D4 — project / session templates ("recipes") persisted
// at ~/.arco/templates.json. CRUD through the three HTTP endpoints
// (GET / POST / DELETE /api/templates). Single-tab analogue of
// useClusterPresets; the persisted model is validated against the live catalog
// at apply time in the creator (not here).

import { useCallback, useEffect, useState } from 'react';
import type { WorkflowTemplate, WorkflowTemplateConfig } from '@arco/shared';

export interface SaveTemplateInput {
  name: string;
  config: WorkflowTemplateConfig;
  seedPrompt?: string;
  plan?: string;
}

export interface UseTemplates {
  templates: WorkflowTemplate[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  save: (input: SaveTemplateInput) => Promise<WorkflowTemplate>;
  delete: (id: string) => Promise<void>;
}

export function useTemplates(): UseTemplates {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/templates');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const data = await res.json() as { templates: WorkflowTemplate[] };
      setTemplates(Array.isArray(data.templates) ? data.templates : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const save = useCallback(async (input: SaveTemplateInput): Promise<WorkflowTemplate> => {
    const res = await fetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    const data = await res.json() as { template: WorkflowTemplate };
    // Optimistically merge; refresh next render keeps the canonical sort.
    setTemplates((prev) => [data.template, ...prev]);
    return data.template;
  }, []);

  const del = useCallback(async (id: string): Promise<void> => {
    const res = await fetch(`/api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    setTemplates((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { templates, isLoading, error, refresh, save, delete: del };
}
