// Strip orchestrator-internal JSON blocks (worker specs, state mutations, QC
// verdicts) and arco-artifact blocks from the rendered chat text. The
// orchestrator emits these alongside its prose for the server to parse —
// rendering the full JSON in chat just clutters the conversation, since the
// task body already lives on the worker card / detail modal.
//
// Source text is left untouched (orchestrator's own --resume context still
// sees the original message). This transform is render-only.

interface CleanedChatText {
  text: string;
  dispatchedWorkers: number;
  stateMutations: number;
  qualityVerdicts: number;
  artifacts: number;
  dispatchMode?: string;
}

const FENCED_BLOCK_RE = /```(\w+)?\s*\n([\s\S]*?)```/g;
// Opening-fence shape for the trailing-unclosed check: lang tag + newline.
const FENCE_OPEN_RE = /^```(\w+)?\s*\n([\s\S]*)$/;

// The trailing fenced block that is opened but not yet closed (mid-stream), or
// null. Fences pair up in order, so a block is unclosed only when the ``` count
// is odd — and then it's the LAST fence. Prior bug: a regex anchored at the
// FIRST ``` and greedy to end-of-string treated a closed ```json block
// followed by prose as unclosed (its "body" didn't end in ```), replacing the
// block and every word after it with "→ assembling…" — permanently, since the
// finished message has the same shape.
function trailingUnclosedFence(text: string): { index: number; lang?: string; body: string } | null {
  let count = 0;
  let last = -1;
  for (let i = text.indexOf('```'); i !== -1; i = text.indexOf('```', i + 3)) {
    count++;
    last = i;
  }
  if (count % 2 === 0) return null;
  const m = FENCE_OPEN_RE.exec(text.slice(last));
  if (!m) return null;
  return { index: last, lang: m[1], body: m[2] };
}

/** Strips primary-internal JSON/artifact blocks from chat content, returning cleaned text and block counts. */
export function cleanPrimaryText(content: string): CleanedChatText {
  const result: CleanedChatText = {
    text: content,
    dispatchedWorkers: 0,
    stateMutations: 0,
    qualityVerdicts: 0,
    artifacts: 0,
  };

  // First pass: replace COMPLETE fenced blocks (those with a closing ```).
  result.text = content.replace(FENCED_BLOCK_RE, (full, lang, body) => {
    const trimmed = (body as string).trim();
    if (lang === 'arco-artifact') {
      result.artifacts++;
      return tagLine('artifact');
    }
    if (lang === 'json' || !lang) {
      const isDispatch = /"dispatch"\s*:\s*\{/.test(trimmed);
      const isWorkers = /"workers"\s*:/.test(trimmed) && !isDispatch;
      const isMutations = /"stateMutations"\s*:/.test(trimmed);
      const isVerdicts = /"qualityVerdicts"\s*:/.test(trimmed);
      if (isDispatch || isWorkers || isMutations || isVerdicts) {
        const lines: string[] = [];
        if (isDispatch) {
          const dispatched = describeDispatch(trimmed);
          result.dispatchedWorkers += dispatched.count;
          if (dispatched.mode) result.dispatchMode = dispatched.mode;
          lines.push(`${dispatched.mode ?? 'dispatched'}: ${dispatched.summary}`);
          if (dispatched.lineage.length > 0) {
            for (const lin of dispatched.lineage) lines.push(lin);
          }
        }
        if (isWorkers) {
          // Legacy format — surface prominently so prompt regressions are visible
          // to the operator (server will have also sent an error).
          const dispatched = describeWorkers(trimmed);
          result.dispatchedWorkers += dispatched.count;
          lines.push(`LEGACY workers block (expected dispatch): ${dispatched.summary}`);
        }
        if (isMutations) {
          result.stateMutations++;
          lines.push('updated state');
        }
        if (isVerdicts) {
          result.qualityVerdicts++;
          lines.push('recorded QC');
        }
        return lines.map((l) => tagLine(l)).join('');
      }
    }
    return full; // not orchestrator-internal — leave it alone
  });

  // Second pass: hide an UNCLOSED trailing fenced block. While the orchestrator
  // is still streaming, the closing ``` hasn't arrived yet — the first pass
  // skipped it and the partial JSON is showing through verbatim. Detect that
  // case and replace with a streaming-placeholder tag. Once the closing ```
  // arrives the first pass takes over.
  const unclosed = trailingUnclosedFence(result.text);
  if (unclosed) {
    const { lang, body } = unclosed;
    if (lang === 'arco-artifact') {
      result.text = result.text.slice(0, unclosed.index) + tagLine('artifact (streaming…)');
    } else if (lang === 'json' || !lang) {
      // Be permissive — any partial JSON object in a json fence at end of
      // stream is almost certainly the orchestrator's dispatch block or a
      // mutation block. Worst case we briefly hide a real JSON answer that
      // won't appear in chat until the close arrives, which is fine.
      const isOrchestratorInternal = /"dispatch"|"workers"|"stateMutations"|"qualityVerdicts"/.test(body)
        || /^\s*\{/.test(body);
      if (isOrchestratorInternal) {
        result.text = result.text.slice(0, unclosed.index) + tagLine('assembling…');
      }
    }
  }

  // Collapse runs of whitespace left behind by the strip.
  result.text = result.text.replace(/\n{3,}/g, '\n\n').trim();

  return result;
}

function tagLine(label: string): string {
  return `\n→ ${label}\n`;
}

// Parse the workers JSON block well enough to surface per-worker model labels
// and escalation/review lineage in chat. Permissive — only needs to extract
// id/model/provider/escalation fields. Falls back to a count if parse fails
// (e.g. mid-stream partial JSON that already passed the unclosed-block check).
interface DescribedDispatch {
  count: number;
  summary: string;       // "w1 (sonnet) · w2 (gpt-5.4-mini)"
  lineage: string[];     // ["↻ w2b escalated from w2 (sonnet → opus)", ...]
}

// New-format dispatch block: `{ "dispatch": { "mode": "...", "workers": [...], ... } }`.
// Extracts mode + worker labels for the chat-line summary.
interface DescribedDispatchBlock extends DescribedDispatch {
  mode: string | null;
}

function describeDispatch(jsonText: string): DescribedDispatchBlock {
  try {
    const parsed = JSON.parse(jsonText) as { dispatch?: { mode?: string; workers?: Array<Record<string, unknown>> } };
    const d = parsed?.dispatch;
    if (!d) return { count: 0, summary: '0 workers', lineage: [], mode: null };
    const mode = typeof d.mode === 'string' ? d.mode.toLowerCase() : null;
    const inner = describeWorkers(JSON.stringify({ workers: d.workers ?? [] }));
    return { ...inner, mode };
  } catch {
    return { count: 0, summary: 'unparsed', lineage: [], mode: null };
  }
}

function describeWorkers(jsonText: string): DescribedDispatch {
  try {
    const parsed = JSON.parse(jsonText) as { workers?: Array<Record<string, unknown>> };
    const workers = Array.isArray(parsed?.workers) ? parsed.workers : [];
    if (workers.length === 0) {
      return { count: 0, summary: '0 workers', lineage: [] };
    }
    const labels: string[] = [];
    const lineage: string[] = [];
    for (const w of workers) {
      const id = typeof w.id === 'string' ? w.id : '?';
      const model = typeof w.model === 'string' ? w.model : '?';
      const provider = typeof w.provider === 'string' ? w.provider : 'claude';
      const tag = provider !== 'claude' ? `${provider}/${model}` : model;
      labels.push(`${id} (${tag})`);
      const escFrom = typeof w.escalatedFromWorkerId === 'string' ? w.escalatedFromWorkerId : null;
      const reviewing = typeof w.reviewingWorkerId === 'string' ? w.reviewingWorkerId : null;
      if (escFrom) {
        lineage.push(`↻ ${id} escalated from ${escFrom} → ${tag}`);
      } else if (reviewing) {
        lineage.push(`✦ ${id} reviewing ${reviewing} (${tag})`);
      }
    }
    return {
      count: workers.length,
      summary: workers.length === 1
        ? labels[0]
        : `${workers.length} workers · ${labels.join(' · ')}`,
      lineage,
    };
  } catch {
    // Fallback: cheap id count.
    const matches = jsonText.match(/"id"\s*:/g);
    const count = matches ? matches.length : 1;
    return {
      count,
      summary: `${count} worker${count === 1 ? '' : 's'}`,
      lineage: [],
    };
  }
}
