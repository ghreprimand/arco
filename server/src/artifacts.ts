import type { ArtifactKind } from '@archon/shared';

// Extract `archon-artifact` fenced blocks from an orchestrator turn's text.
// The orchestrator is taught (via ORCHESTRATOR_SYSTEM_PROMPT) to emit these
// when it wants to show the operator something in a modal or ask for a
// decision. Invalid JSON is silently dropped — we never want artifact
// extraction to break the chat flow.

export interface ArtifactPayload {
  kind: ArtifactKind;
  title?: string;
  content?: string;
  language?: string;
  path?: string;
  message?: string;
  choices?: string[];
}

const VALID_KINDS: ArtifactKind[] = ['image', 'code', 'text', 'diff', 'confirm', 'choice'];

function normalize(raw: unknown): ArtifactPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = typeof o.kind === 'string' ? (o.kind as ArtifactKind) : null;
  if (!kind || !VALID_KINDS.includes(kind)) return null;

  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const strArr = (k: string): string[] | undefined => {
    if (!Array.isArray(o[k])) return undefined;
    const arr = (o[k] as unknown[]).filter((x): x is string => typeof x === 'string');
    return arr.length > 0 ? arr : undefined;
  };

  return {
    kind,
    title: str('title'),
    content: str('content'),
    language: str('language'),
    path: str('path'),
    message: str('message'),
    choices: strArr('choices'),
  };
}

export function extractArtifacts(text: string): ArtifactPayload[] {
  const out: ArtifactPayload[] = [];
  const regex = /```archon-artifact\s*\n([\s\S]*?)```/g;
  for (const match of text.matchAll(regex)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const normalized = normalize(parsed);
      if (normalized) out.push(normalized);
    } catch {
      // Bad JSON — silently skip
    }
  }
  return out;
}
