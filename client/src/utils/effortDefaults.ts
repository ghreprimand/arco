// Defaults for new work never start above HIGH. XHIGH, MAX and ULTRA spend
// quota quickly, so they are set only by an explicit click on an effort
// control (or by Ultracode, which pins XHIGH). Existing work (resume, restore,
// running workflows) keeps its own effort; these helpers apply to values that
// are filled in automatically for new work.
import { EFFORT_RANK, type ClaudeCatalogSnapshot, type CodexCatalogSnapshot, type EffortLevel, type ModelName, type ProviderName, type WorkflowDefaults } from '@arco/shared';
import { effortsForModel } from './format.js';

export const DEFAULT_EFFORT_CAP: EffortLevel = 'high';
export const DEFAULT_TOOL_FILTER = 'conservative' as const;
export const DEFAULT_OUTPUT_STYLE = 'lite' as const;
export const EFFORT_RESET_NOTE = 'Effort reset to HIGH after the model changed. Choose XHIGH or MAX again if needed.';
export const EFFORT_SAVE_NOTE = 'Defaults store at most HIGH; saved effort as HIGH.';

export function isAboveDefaultCap(effort: EffortLevel | string | undefined): boolean {
  return effort !== undefined && (EFFORT_RANK[effort as EffortLevel] ?? -1) > EFFORT_RANK[DEFAULT_EFFORT_CAP];
}

/** Cap an automatically filled effort at HIGH, then fit it to the model. */
export function capDefaultEffort(
  effort: EffortLevel | undefined,
  provider?: ProviderName,
  model?: ModelName,
  claudeCatalog?: ClaudeCatalogSnapshot | null,
  codexCatalog?: CodexCatalogSnapshot | null,
): EffortLevel {
  const wanted: EffortLevel = !effort || isAboveDefaultCap(effort) ? DEFAULT_EFFORT_CAP : effort;
  const allowed = effortsForModel(provider, model, claudeCatalog, codexCatalog);
  if (allowed.length === 0 || allowed.includes(wanted)) return wanted;
  const within = allowed.filter((e) => EFFORT_RANK[e] <= EFFORT_RANK[wanted]);
  return within.length > 0 ? within[within.length - 1] : allowed[0];
}

/** Initial creator values for a home: saved choices win; missing ones use shipped defaults. */
export function initialCreatorDefaults(wd: WorkflowDefaults | undefined) {
  return {
    effort: capDefaultEffort(wd?.primaryEffort),
    efficiencyToolFilter: wd?.efficiencyToolFilter ?? DEFAULT_TOOL_FILTER,
    outputStyle: wd?.outputStyle ?? DEFAULT_OUTPUT_STYLE,
  };
}

/**
 * Effort after a model or provider change. An explicit XHIGH or MAX does not
 * carry over to another model: it resets to HIGH with a visible note. Ultracode
 * keeps its pinned XHIGH where the model supports it.
 */
export function effortAfterModelChange(
  effort: EffortLevel,
  opts: { explicit: boolean; ultracode: boolean; provider?: ProviderName; model?: ModelName; claudeCatalog?: ClaudeCatalogSnapshot | null; codexCatalog?: CodexCatalogSnapshot | null },
): { effort: EffortLevel; note: string | null } {
  const { provider, model, claudeCatalog, codexCatalog } = opts;
  if (opts.ultracode) {
    const allowed = effortsForModel(provider, model, claudeCatalog, codexCatalog);
    if (allowed.length === 0 || allowed.includes(effort)) return { effort, note: null };
  }
  const next = capDefaultEffort(effort, provider, model, claudeCatalog, codexCatalog);
  return { effort: next, note: isAboveDefaultCap(effort) && opts.explicit ? EFFORT_RESET_NOTE : null };
}
