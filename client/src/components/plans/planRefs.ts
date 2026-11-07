// Plan reference docs — client half. Refs live at
// <cwd>/.arco/plans/<planId>.refs/<slug>.md (server planStore.ts); these are
// thin wrappers over /api/plans/refs plus the link syntax the plan body uses
// to point at one: `[label](ref:slug)` or `[[ref:slug]]`.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlanRefFull, PlanRefSummary } from '@arco/shared';

export const REF_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Global — callers reset lastIndex via matchAll / split usage. The third
// alternative is a bare `ref:slug` mention in prose ("per ref:api-shape"); the
// lookbehind keeps it from matching inside a word or a URL path.
export const REF_LINK_RE = /\[([^\]\n]+)\]\(ref:([a-z0-9][a-z0-9-]{0,63})\)|\[\[ref:([a-z0-9][a-z0-9-]{0,63})\]\]|(?<![\w/:-])ref:([a-z0-9][a-z0-9-]{0,63})/g;

export type RefLinkPart = string | { label: string; slug: string };

export function splitRefLinks(text: string): RefLinkPart[] {
  const parts: RefLinkPart[] = [];
  let last = 0;
  for (const m of text.matchAll(REF_LINK_RE)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const slug = m[2] ?? m[3] ?? m[4];
    parts.push({ label: m[1] ?? slug, slug });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// Turn an arbitrary title into a valid slug suggestion.
export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'ref';
}

const q = (cwd: string, planId: string, slug?: string) =>
  new URLSearchParams({ path: cwd, planId, ...(slug ? { slug } : {}) }).toString();

async function asJson<T>(r: Response): Promise<T> {
  const d = await r.json().catch(() => ({})) as T & { error?: string };
  if (!r.ok) throw Object.assign(new Error(d.error ?? `HTTP ${r.status}`), { status: r.status });
  return d;
}

export async function fetchPlanRefs(cwd: string, planId: string): Promise<PlanRefSummary[]> {
  return (await asJson<{ refs: PlanRefSummary[] }>(await fetch(`/api/plans/refs?${q(cwd, planId)}`))).refs;
}

export async function fetchPlanRef(cwd: string, planId: string, slug: string): Promise<PlanRefFull> {
  return (await asJson<{ ref: PlanRefFull }>(await fetch(`/api/plans/refs/body?${q(cwd, planId, slug)}`))).ref;
}

export async function savePlanRef(cwd: string, planId: string, slug: string, body: string, opts: { createOnly?: boolean } = {}): Promise<void> {
  await asJson(await fetch(`/api/plans/refs?${q(cwd, planId, slug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, ...opts }),
  }));
}

export async function removePlanRef(cwd: string, planId: string, slug: string): Promise<void> {
  await asJson(await fetch(`/api/plans/refs?${q(cwd, planId, slug)}`, { method: 'DELETE' }));
}

// Refetches whenever the plan's updatedAt bumps — the server bumps it on every
// ref write/delete made through the REST routes. Refs an agent writes with
// plain file tools don't bump it, so focus also refetches.
export function usePlanRefs(cwd: string | undefined, planId: string | undefined, updatedAt?: number) {
  const key = JSON.stringify([cwd, planId]);
  const active = useRef({ key, generation: 0 });
  if (active.current.key !== key) active.current = { key, generation: active.current.generation + 1 };
  const [listed, setListed] = useState<{ key: string; refs: PlanRefSummary[] } | null>(null);
  const reload = useCallback(async () => {
    if (active.current.key !== key) return;
    const request = ++active.current.generation;
    if (!cwd || !planId) { setListed(null); return; }
    try {
      const refs = await fetchPlanRefs(cwd, planId);
      if (active.current.key === key && active.current.generation === request) setListed({ key, refs });
    } catch { /* Keep this plan's prior list on a failed refresh. */ }
  }, [cwd, planId, key]);
  useEffect(() => {
    void reload();
    return () => { active.current.generation++; };
  }, [reload, updatedAt]);
  useEffect(() => {
    const onFocus = () => { void reload(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);
  return { refs: listed?.key === key ? listed.refs : null, reload };
}
