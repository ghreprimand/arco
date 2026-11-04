// §2.1 — deterministic Fold digest (Claude Native).
//
// The Fold replaces a mid-history prefix with a single compact summary while
// keeping a verbatim recent tail and continuing the SAME session (vs Handoff,
// which spawns a fresh worker off a portable doc). The summary must be cheap
// and reproducible — so it is built deterministically (NO model call) from the
// prefix being folded plus the worker's live todo list, extracting the
// categories an agent needs to keep working: the original task, files touched,
// commands run, searches, errors, the most recent operator asks, and the
// still-open todos.
//
// Pure: walks message content blocks, no I/O, no model. Mirrors the extraction
// in exportContext.summarizePriorTurns / resumeSummary.summarizeClaudeNative-
// PriorTurns but operates on the in-memory MessageParam prefix (which is what
// is actually being removed from context) rather than events.jsonl — same
// information categories, no new worker→disk dependency, and it summarizes
// exactly what the fold drops.

export interface FoldDigestTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

interface FoldMessage {
  role: string;
  content: unknown;
}

function blocks(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

function flattenText(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocks(content)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

function shorten(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

// Build the deterministic digest markdown for a folded prefix. `activeTodos`
// is the worker's live todo list; only un-ticked (pending / in_progress) items
// are re-injected — completed ones are noise the model doesn't need to carry.
export function buildFoldDigest(prefix: FoldMessage[], activeTodos: FoldDigestTodo[] = []): string {
  let originalTask = '';
  const filesWritten = new Set<string>();
  const filesRead = new Set<string>();
  const bashCmds: string[] = [];
  const searches: string[] = [];
  let errorCount = 0;
  const userAsks: string[] = [];

  for (const msg of prefix) {
    if (msg.role === 'user') {
      // A user message is either an operator turn (text) or a tool_result
      // batch. Count errors from tool_result blocks; collect operator text.
      const bs = blocks(msg.content);
      const isToolResultBatch = bs.length > 0 && bs.every((b) => b.type === 'tool_result');
      if (isToolResultBatch) {
        for (const b of bs) if (b.is_error === true) errorCount++;
      } else {
        const text = flattenText(msg.content).trim();
        if (text) {
          if (!originalTask) originalTask = text;
          userAsks.push(text);
        }
      }
    } else if (msg.role === 'assistant') {
      for (const b of blocks(msg.content)) {
        if (b.type !== 'tool_use') continue;
        const name = typeof b.name === 'string' ? b.name : '';
        const input = (b.input ?? {}) as Record<string, unknown>;
        if ((name === 'Write' || name === 'Edit' || name === 'NotebookEdit')) {
          const f = input.file_path ?? input.notebook_path ?? input.path;
          if (typeof f === 'string') filesWritten.add(f);
        } else if (name === 'Read') {
          const f = input.file_path ?? input.path;
          if (typeof f === 'string') filesRead.add(f);
        } else if (name === 'Bash' && typeof input.command === 'string') {
          bashCmds.push(input.command.split('\n')[0].slice(0, 120));
        } else if ((name === 'Grep' || name === 'Glob') && typeof input.pattern === 'string') {
          searches.push(input.pattern.slice(0, 80));
        }
      }
    }
  }

  const lines: string[] = ['## Folded context (deterministic digest of older history)'];
  if (originalTask) {
    lines.push('', `**Original task:** ${shorten(originalTask, 400)}`);
  }
  if (filesWritten.size > 0) {
    lines.push('', `**Files written/edited (${filesWritten.size}):** ${[...filesWritten].slice(0, 30).join(', ')}${filesWritten.size > 30 ? ` (+${filesWritten.size - 30} more)` : ''}`);
  }
  if (filesRead.size > 0) {
    const reads = [...filesRead];
    lines.push('', `**Files read (${reads.length}):** ${reads.slice(0, 20).join(', ')}${reads.length > 20 ? ` (+${reads.length - 20} more)` : ''}`);
  }
  if (bashCmds.length > 0) {
    const shown = bashCmds.slice(-15);
    lines.push('', '**Commands run:**', ...shown.map((c) => `- \`${c}\``));
  }
  if (searches.length > 0) {
    lines.push('', `**Searches:** ${searches.slice(-12).map((s) => `\`${s}\``).join(', ')}`);
  }
  if (errorCount > 0) {
    lines.push('', `**Tool errors encountered:** ${errorCount}`);
  }
  // Most recent operator asks (after the original) — the live intent the model
  // should continue serving. Skip the first (already shown as Original task).
  const recentAsks = userAsks.slice(1).slice(-3);
  if (recentAsks.length > 0) {
    lines.push('', '**Recent operator asks:**', ...recentAsks.map((a) => `- ${shorten(a, 200)}`));
  }
  const openTodos = activeTodos.filter((t) => t.status !== 'completed');
  if (openTodos.length > 0) {
    lines.push('', '**Open todos (carry forward):**', ...openTodos.map((t) => `- [${t.status === 'in_progress' ? '~' : ' '}] ${shorten(t.content, 160)}`));
  }
  lines.push('', '_(Older tool output was folded to free context; the full transcript remains in events.jsonl. Re-read files or re-run commands if you need exact detail.)_');
  return lines.join('\n');
}
