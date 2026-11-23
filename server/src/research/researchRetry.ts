// docs/RESEARCH.md "Retry" - the work-so-far file a researcher gets when the
// operator presses RETRY. Built once, at retry time, from Arco's own record of
// the researcher's turns (its workflow event log); provider-private files are
// never read. Reasoning, text and tool inputs are kept whole; long tool
// outputs are cut with a marked cut so the file stays readable.

import { readLogLines } from '../eventLog.js';

const OUTPUT_CUT = 2000;
// Stays below the peer artifact limit (256 KiB) with room for the header.
const FILE_MAX_BYTES = 240 * 1024;

type ToolBlock = { kind: 'tool'; tool: string; input: string; output?: string; status?: string };
export type WorkBlock = { kind: 'turn'; at: number } | { kind: 'thinking' | 'text' | 'error'; text: string } | ToolBlock;

interface LogEvent { type?: string; ts?: number; text?: unknown; message?: unknown; tool?: unknown; input?: unknown; output?: unknown; status?: unknown; itemId?: unknown; toolUseId?: unknown; startedAt?: unknown }

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[... ${text.length - max} characters cut by Arco ...]`;
}

/** The researcher's reasoning, tool calls, outputs and text since `sinceMs`, in order. */
export async function readWorkSoFar(workflowDir: string, sinceMs: number): Promise<WorkBlock[]> {
  const blocks: WorkBlock[] = [];
  const tools = new Map<string, ToolBlock>();
  try {
    for await (const line of readLogLines(workflowDir)) {
      let ev: LogEvent;
      try { ev = JSON.parse(line); } catch { continue; }
      if (typeof ev.ts === 'number' && ev.ts < sinceMs) continue;
      const last = blocks.at(-1);
      if (ev.type === 'primary_turn_started') blocks.push({ kind: 'turn', at: typeof ev.startedAt === 'number' ? ev.startedAt : ev.ts ?? 0 });
      else if ((ev.type === 'primary_thinking' || ev.type === 'primary_text') && typeof ev.text === 'string') {
        const kind = ev.type === 'primary_thinking' ? 'thinking' : 'text';
        if (last && last.kind === kind) last.text += ev.text;
        else blocks.push({ kind, text: ev.text });
      } else if (ev.type === 'error' && typeof ev.message === 'string') blocks.push({ kind: 'error', text: ev.message });
      else if (ev.type === 'primary_tool_use') {
        const id = typeof ev.itemId === 'string' ? ev.itemId : typeof ev.toolUseId === 'string' ? ev.toolUseId : undefined;
        const known = id ? tools.get(id) : undefined;
        const output = typeof ev.output === 'string' && ev.output ? ev.output : undefined;
        if (known) {
          if (output) known.output = output;
          if (typeof ev.status === 'string') known.status = ev.status;
          continue;
        }
        const block: ToolBlock = { kind: 'tool', tool: String(ev.tool ?? 'tool'), input: typeof ev.input === 'string' ? ev.input : '', ...(output ? { output } : {}), ...(typeof ev.status === 'string' ? { status: ev.status } : {}) };
        blocks.push(block);
        if (id) tools.set(id, block);
      }
    }
  } catch { /* no log yet: the file says so */ }
  return blocks;
}

function render(blocks: WorkBlock[], outputMax: number): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'turn') out.push(`### Turn started ${new Date(b.at).toISOString()}`, '');
    else if (b.kind === 'thinking') out.push('Reasoning:', '', b.text.trim(), '');
    else if (b.kind === 'text') out.push('Text you wrote:', '', b.text.trim(), '');
    else if (b.kind === 'error') out.push(`Error: ${b.text.trim()}`, '');
    else if (b.kind === 'tool') {
      out.push(`Tool call: ${b.tool}${b.status === 'failed' ? ' (failed)' : ''}`, '', 'Input:', '', '```', b.input, '```', '');
      out.push(...(b.output !== undefined ? ['Output:', '', '```', cut(b.output, outputMax), '```', ''] : ['Output: not recorded by Arco.', '']));
    }
  }
  return out;
}

/** The markdown file: the round text, the work in order, then how the turn ended. */
export function workSoFarFile(opts: { title: string; letter: string; roundText: string; reason: string; blocks: WorkBlock[] }): string {
  const head = [`# Work so far: ${opts.title}, Researcher ${opts.letter}`, '',
    'Written by Arco when the operator asked you to retry. It is Arco\'s record of your earlier work on this round, not a provider transcript. A tool call whose output a provider does not report shows "Output: not recorded by Arco."', '',
    '## Round text', '', opts.roundText.trim(), '', '## Your work so far', ''];
  const tail = ['## How the turn ended', '', opts.reason.trim() || 'No reason was recorded.', ''];
  const empty = ['Arco has no record of work in this round.', ''];
  for (const max of [OUTPUT_CUT, 500, 0]) {
    const text = [...head, ...(opts.blocks.length ? render(opts.blocks, max) : empty), ...tail].join('\n');
    if (Buffer.byteLength(text, 'utf8') <= FILE_MAX_BYTES) return text;
  }
  // Still too large: keep the latest work, which the researcher continues from.
  const body = render(opts.blocks, 0).join('\n');
  const room = FILE_MAX_BYTES - Buffer.byteLength([...head, ...tail].join('\n'), 'utf8') - 200;
  return [...head, '[... earlier work cut by Arco to fit the file ...]', '', Buffer.from(body, 'utf8').subarray(-Math.max(1, room)).toString('utf8'), '', ...tail].join('\n');
}
