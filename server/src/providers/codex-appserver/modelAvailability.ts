// docs/PROVIDERS.md (Codex app-server model catalog) - a saved Codex model
// that the running Codex CLI does not offer for the signed-in account. Codex
// answers `model/list` per account and per CLI version: an older CLI does not
// offer newer models, and sending one fails the turn with
// `model_not_in_accessible_catalog`. The worker then runs on Codex's default
// model for that list and says so; the saved model is left as it is.

export interface OfferedCodexModel { id: string; isDefault?: boolean; hidden?: boolean }

export interface CodexModelChoice { model: string; unavailable?: string }

/** The model a turn runs on: the saved one when Codex lists it (or lists
 * nothing), else Codex's default visible model. */
export function codexModelForTurn(saved: string, offered: readonly OfferedCodexModel[]): CodexModelChoice {
  if (!saved || offered.length === 0 || offered.some((m) => m.id === saved)) return { model: saved };
  const fallback = offered.find((m) => m.isDefault && !m.hidden) ?? offered.find((m) => !m.hidden);
  return fallback ? { model: fallback.id, unavailable: saved } : { model: saved };
}

/** The Codex CLI version in an app-server user agent such as
 * `arco/0.150.1 (Linux ...)`. */
export function codexVersionOf(userAgent: string | null | undefined): string | null {
  return /\/(\d+\.\d+\.\d+)/.exec(userAgent ?? '')?.[1] ?? null;
}

function codexLabel(version: string | null): string {
  return version ? `Codex ${version}` : 'This Codex';
}

/** The chat notice for a turn that ran on another model. */
export function codexModelFallbackNotice(choice: Required<CodexModelChoice>, version: string | null): string {
  return `${codexLabel(version)} does not offer ${choice.unavailable} for this account, so this conversation is using ${choice.model}. Choose a model in the model picker, or update Codex to use ${choice.unavailable}.`;
}

/** A readable sentence for Codex's refusal of a model it does not offer, or
 * null for any other error. */
export function readableCodexModelError(message: string, model: string, version: string | null): string | null {
  if (!/model_not_in_accessible_catalog|"code":\s*"model_not_found"|model is not supported when using Codex/.test(message)) return null;
  return `${codexLabel(version)} does not offer ${model} for this account. Choose another model in the model picker, or update Codex to use ${model}.`;
}
