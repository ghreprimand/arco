// Cursor model ids come in two forms that must be matched exactly:
//
//   - The catalog (`cursor-agent models`) lists one id per variant, for
//     example `grok-4.7-medium`, `grok-4.7-high-fast`,
//     `claude-4.6-sonnet-medium-thinking`. Arco's model picker uses these.
//   - ACP (`session/new`, `session/load`) advertises ONE id per model, carrying
//     the parameters saved for that model in the Cursor CLI, for example
//     `grok-4.7[context=256k,reasoning_effort=high,fast=true]`, and Auto as
//     `default[]`. `session/set_model` and `session/set_config_option` accept
//     only these advertised ids (fixtures/acp-models.json).
//
// So a catalog variant can be selected over ACP only when the advertised id
// for its model carries the same effort, fast and thinking settings. Matching
// compares the model-name tokens (in any order: the catalog writes
// `claude-4.6-sonnet`, ACP `claude-sonnet-4-6`) and those three settings.
// Context sizes are not part of catalog ids and are ignored.

import { JsonRpcRequestError } from './acpJsonRpc.js';

export interface AcpModel { modelId: string; name?: string }

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const EFFORT_KEYS = ['effort', 'reasoning_effort', 'reasoning'];

interface Variant {
  base: string[];            // model-name tokens in order
  effort: string | null;     // normalized, null when not given
  fast: boolean;
  thinking: boolean;
}

function normEffort(v: string): string {
  const s = v.trim().toLowerCase();
  return s === 'extra-high' || s === 'extra_high' || s === 'extrahigh' ? 'xhigh' : s;
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[-._\s]+/).filter(Boolean);
}

export function isAutoModel(id: string): boolean {
  const s = id.trim().toLowerCase();
  return s === '' || s === 'auto' || s === 'default' || s === 'default[]';
}

// `grok-4.7-high-fast` -> base [grok, 4, 7], effort high, fast. Unlike the
// picker's parseCursorModelId (shared), any token may be the effort and
// `minimal` counts as one, so every catalog id splits into name and settings.
export function parseCatalogId(id: string): Variant {
  const t = tokens(id);
  const base: string[] = [];
  let effort: string | null = null, fast = false, thinking = false;
  for (let i = 0; i < t.length; i++) {
    const w = t[i];
    if (w === 'fast') { fast = true; continue; }
    if (w === 'thinking') { thinking = true; continue; }
    if (w === 'extra' && t[i + 1] === 'high') { effort = 'xhigh'; i++; continue; }
    if ((EFFORTS as readonly string[]).includes(w)) { effort = w; continue; }
    base.push(w);
  }
  return { base, effort, fast, thinking };
}

// `grok-4.7[context=256k,reasoning_effort=high,fast=true]` -> base, params.
export function parseAcpModelId(id: string): { base: string; params: Record<string, string> } {
  const m = /^([^[]*)(?:\[(.*)\])?$/.exec(id.trim());
  const base = (m?.[1] ?? id).trim();
  const params: Record<string, string> = {};
  for (const part of (m?.[2] ?? '').split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) params[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim().toLowerCase();
  }
  return { base, params };
}

function acpVariant(id: string): Variant & { hasThinking: boolean } {
  const { base, params } = parseAcpModelId(id);
  const key = EFFORT_KEYS.find((k) => k in params);
  return {
    base: tokens(base),
    effort: key ? normEffort(params[key]) : null,
    fast: params.fast === 'true',
    thinking: params.thinking === 'true',
    hasThinking: 'thinking' in params,
  };
}

const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const sameSet = (a: string[], b: string[]): boolean => same([...a].sort(), [...b].sort());

// The advertised ACP model for the same model as `catalogId`, if any.
function sameModel(catalogBase: string[], available: AcpModel[]): AcpModel | null {
  const exact = available.find((m) => same(acpVariant(m.modelId).base, catalogBase));
  if (exact) return exact;
  const loose = available.filter((m) => sameSet(acpVariant(m.modelId).base, catalogBase));
  return loose.length === 1 ? loose[0] : null;
}

// Does the advertised variant `acpId` run exactly the catalog variant `catalogId`?
// `catalog` is the full catalog id list, used to tell what an id without an
// effort (or without `thinking`) means for that model.
export function acpMatchesCatalog(acpId: string, catalogId: string, catalog: readonly string[]): boolean {
  if (isAutoModel(catalogId)) return isAutoModel(acpId);
  if (isAutoModel(acpId)) return false;
  const a = acpVariant(acpId);
  const w = parseCatalogId(catalogId);
  if (!sameSet(a.base, w.base)) return false;
  if (a.fast !== w.fast) return false;
  const siblings = catalog.map(parseCatalogId).filter((v) => sameSet(v.base, w.base));
  // Thinking counts only where the catalog offers the model both ways.
  const thinkingMatters = a.hasThinking && siblings.some((v) => v.thinking) && siblings.some((v) => !v.thinking);
  if (thinkingMatters && a.thinking !== w.thinking) return false;
  const alike = siblings.filter((v) => v.fast === w.fast && (!thinkingMatters || v.thinking === w.thinking));
  // ACP gives no effort: only safe when the catalog offers one effort here.
  if (a.effort === null) return new Set(alike.map((v) => v.effort)).size <= 1;
  if (w.effort !== null) return a.effort === w.effort;
  // No effort in the catalog id: it is the model's default effort, which is
  // any effort not listed as its own variant (same thinking and fast).
  return !alike.some((v) => v.effort === a.effort);
}

export type ModelResolution =
  | { kind: 'exact'; acpId: string }
  // The model is offered, but only with other settings (the Cursor CLI's saved ones).
  | { kind: 'other-variant'; acpId: string; effective: string }
  | { kind: 'unavailable' };

export function resolveCatalogModel(wanted: string, available: AcpModel[], catalog: readonly string[]): ModelResolution {
  if (isAutoModel(wanted)) {
    const auto = available.find((m) => isAutoModel(m.modelId));
    return auto ? { kind: 'exact', acpId: auto.modelId } : { kind: 'unavailable' };
  }
  const exact = available.find((m) => acpMatchesCatalog(m.modelId, wanted, catalog));
  if (exact) return { kind: 'exact', acpId: exact.modelId };
  const other = sameModel(parseCatalogId(wanted).base, available);
  if (other) return { kind: 'other-variant', acpId: other.modelId, effective: describeAcpModel(other.modelId, catalog) };
  return { kind: 'unavailable' };
}

// Catalog id for an advertised variant, or a readable description when none matches.
export function describeAcpModel(acpId: string, catalog: readonly string[]): string {
  if (isAutoModel(acpId)) return 'auto';
  const hit = catalog.filter((id) => acpMatchesCatalog(acpId, id, catalog));
  if (hit.length === 1) return hit[0];
  const { base, params } = parseAcpModelId(acpId);
  const v = acpVariant(acpId);
  const bits = [v.effort, v.thinking && 'thinking', v.fast && 'fast'].filter(Boolean);
  return bits.length ? `${base} (${bits.join(', ')})` : (Object.keys(params).length ? acpId : base);
}

// `id - Name` rows of `cursor-agent models`.
export function catalogIds(stdoutLines: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of stdoutLines) {
    const line = raw.trim();
    const dash = line.indexOf(' - ');
    if (dash <= 0) continue;
    const id = line.slice(0, dash).trim();
    if (id && !/\s/.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

interface AcpRequester { request<R>(method: string, params: unknown): Promise<R> }

// Select an advertised model on a session and report the model the session
// says it runs on afterwards (null when the CLI does not say).
// session/set_config_option answers with the session's options, which
// confirms the change; a CLI without it gets session/set_model. Either call
// also saves the choice as the Cursor CLI's default model.
export async function setAcpSessionModel(rpc: AcpRequester, sessionId: string, acpId: string): Promise<string | null> {
  try {
    const res = await rpc.request<{ configOptions?: Array<{ id?: string; currentValue?: unknown }> }>(
      'session/set_config_option', { sessionId, configId: 'model', value: acpId });
    const current = res?.configOptions?.find((o) => o?.id === 'model')?.currentValue;
    return typeof current === 'string' ? current : null;
  } catch (err) {
    if (!(err instanceof JsonRpcRequestError) || err.rpcError.code !== -32601) throw err;
  }
  await rpc.request('session/set_model', { sessionId, modelId: acpId });
  return acpId;
}
