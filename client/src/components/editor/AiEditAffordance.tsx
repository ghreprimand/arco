import { useMemo, useState } from 'react';
import { createTwoFilesPatch } from 'diff';
import { RunAsPicker, type RunAsSelection } from '../RunAsPicker';
import { DiffView } from '../diff/DiffView';
import { useAppStore } from '../../stores/appStore';
import { useDocEditStore } from '../../stores/docEditStore';
import { DOC_EDIT_CONTEXT_LIMIT } from '@arco/shared';
import type { ProviderName, ModelName } from '@arco/shared';

// docs/ARCHITECTURE.md - AI-collaborative document editing affordance.
//
// Mounted by FileViewerModal when the A6 editor is in Edit mode AND there is a
// non-empty selection (or the operator hits SELECT ALL for a whole-doc edit).
// The operator types an instruction, picks the agent via the EXISTING RUN AS
// picker, and submits → fires a doc_edit_request (in-tab; the proposal must
// round-trip to THIS buffer). The doc_edit_proposed event lands in the
// docEditStore; we preview it as an A3 diff (selection-before vs proposed-after)
// with Accept (splice into the buffer — buffer only, NOT disk) and Reject.
//
// FENCE: the agent has NO Write tool (server-side). Accept mutates the buffer
// only; the existing A6 SAVE persists to disk through the guarded write
// endpoint. The operator approves twice. See docEdit.ts / runDocEdit.ts.

interface Props {
  workflowId: string;
  filePath: string;
  // The full current buffer + the live selection (document offsets). When
  // from === to there is no selection; the parent only mounts us when there is
  // one OR after a Select-All.
  buffer: string;
  selectionFrom: number;
  selectionTo: number;
  wholeDoc: boolean;
  // Splice the agent's replacement into [from,to) of the editor BUFFER. Returns
  // the new doc (buffer only — the existing SAVE button writes to disk).
  onAccept: (from: number, to: number, replacement: string) => void;
}

export function AiEditAffordance({ workflowId, filePath, buffer, selectionFrom, selectionTo, wholeDoc, onAccept }: Props) {
  const config = useAppStore((s) => s.jobs[workflowId]?.config);
  const dispatch = useDocEditStore((s) => s.dispatch);
  const clear = useDocEditStore((s) => s.clear);

  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [docEditId, setDocEditId] = useState<string | null>(null);
  const entry = useDocEditStore((s) => (docEditId ? s.byId[docEditId] : undefined));

  const currentPrimary: RunAsSelection = useMemo(() => ({
    provider: (config?.primaryProvider ?? 'claude') as ProviderName,
    model: (config?.primaryModel ?? 'sonnet') as ModelName,
    effort: config?.primaryEffort ?? 'medium',
    providerAccountRef: config?.providerAccountRef,
  }), [config?.primaryProvider, config?.primaryModel, config?.primaryEffort, config?.providerAccountRef]);
  const [runAs, setRunAs] = useState<RunAsSelection>(currentPrimary);

  const selectionText = buffer.slice(selectionFrom, selectionTo);
  const hasSelection = selectionTo > selectionFrom;

  const submit = () => {
    if (!hasSelection || !instruction.trim()) return;
    const id = dispatch({
      workflowId,
      editor: runAs,
      filePath,
      selectionText,
      selectionFrom,
      selectionTo,
      // Bounded surrounding context so the prompt stays scoped.
      contextBefore: buffer.slice(Math.max(0, selectionFrom - DOC_EDIT_CONTEXT_LIMIT), selectionFrom),
      contextAfter: buffer.slice(selectionTo, selectionTo + DOC_EDIT_CONTEXT_LIMIT),
      instruction: instruction.trim(),
      wholeDoc,
    });
    setDocEditId(id);
  };

  const reset = () => {
    if (docEditId) clear(docEditId);
    setDocEditId(null);
    setInstruction('');
    setOpen(false);
  };

  const accept = () => {
    if (!entry || entry.status !== 'proposed') return;
    // Splice into the ORIGINAL echoed range. Buffer only — Save writes to disk.
    onAccept(entry.selectionFrom, entry.selectionTo, entry.replacement);
    reset();
  };

  // A3 DiffView wants a unified-diff string. Build one from selection-before vs
  // proposed-after so the operator reviews exactly what changes in the region.
  const patch = useMemo(() => {
    if (!entry || entry.status !== 'proposed') return '';
    const label = filePath.split('/').pop() || filePath;
    return createTwoFilesPatch(
      `${label} (selection)`, `${label} (proposed)`,
      entry.selectionBefore, entry.replacement,
      '', '', { context: 3 },
    );
  }, [entry, filePath]);

  if (!open) {
    return (
      <button
        onClick={() => { setRunAs(currentPrimary); setOpen(true); }}
        disabled={!hasSelection}
        data-help="aiedit.ask"
        className="display-font"
        title={hasSelection ? 'Ask an AI agent to rewrite the selection' : 'Select a region first'}
        style={{
          position: 'absolute',
          right: '12px',
          top: '10px',
          zIndex: 1001,
          background: 'var(--color-bg)',
          border: `1px solid ${hasSelection ? 'var(--color-accent-secondary)' : 'var(--color-border-hairline)'}`,
          borderRadius: '3px',
          color: hasSelection ? 'var(--color-accent-secondary-dim)' : 'var(--color-fg-muted)',
          cursor: hasSelection ? 'pointer' : 'default',
          fontSize: '10px',
          padding: '4px 10px',
          letterSpacing: '1px',
          opacity: hasSelection ? 1 : 0.5,
        }}
      >
        ✦ ASK AI
      </button>
    );
  }

  const pending = entry?.status === 'pending';
  const proposed = entry?.status === 'proposed';
  const errored = entry?.status === 'error';

  return (
    <div
      style={{
        position: 'absolute',
        right: '12px',
        top: '52px',
        width: '420px',
        maxHeight: '70%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-bg)',
        border: '1px solid var(--color-border-bright)',
        borderRadius: '6px',
        boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
        zIndex: 1001,
        overflow: 'hidden',
      }}
    >
      <div
        className="display-font"
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--color-border-hairline)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: '11px',
          letterSpacing: '1px',
          color: 'var(--color-accent-primary-dim)',
        }}
      >
        <span>ASK AI — {wholeDoc ? 'WHOLE DOC' : `${selectionTo - selectionFrom} CHARS`}</span>
        <button onClick={reset} style={{ background: 'transparent', border: 'none', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '14px' }}>×</button>
      </div>

      <div style={{ padding: '10px 12px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {!proposed && !errored && (
          <>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Instruction — e.g. tighten this paragraph, fix the formatting, rewrite in my voice…"
              data-help="aiedit.instruction"
              disabled={pending}
              rows={3}
              style={{
                width: '100%',
                resize: 'vertical',
                background: 'var(--color-bg-input, var(--color-bg))',
                border: '1px solid var(--color-border-hairline)',
                borderRadius: '4px',
                color: 'var(--color-fg)',
                fontFamily: 'var(--font-body)',
                fontSize: '12px',
                padding: '6px 8px',
                boxSizing: 'border-box',
              }}
            />
            <RunAsPicker current={currentPrimary} selection={runAs} onChange={setRunAs} />
            <button
              onClick={submit}
              disabled={pending || !instruction.trim()}
              className="display-font"
              style={{
                alignSelf: 'flex-start',
                background: 'var(--color-accent-primary-a10)',
                border: '1px solid var(--color-accent-primary)',
                borderRadius: '3px',
                color: 'var(--color-accent-primary)',
                cursor: pending || !instruction.trim() ? 'default' : 'pointer',
                fontSize: '10px',
                padding: '5px 12px',
                letterSpacing: '1px',
                opacity: pending || !instruction.trim() ? 0.5 : 1,
              }}
            >
              {pending ? 'PROPOSING…' : 'PROPOSE EDIT'}
            </button>
          </>
        )}

        {errored && (
          <div style={{ fontSize: '11px', color: 'var(--color-danger)' }}>
            Edit failed: {entry?.error}
            <div style={{ marginTop: '8px' }}>
              <button onClick={() => { if (docEditId) clear(docEditId); setDocEditId(null); }} className="display-font" style={retryStyle}>TRY AGAIN</button>
            </div>
          </div>
        )}

        {proposed && (
          <>
            <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', letterSpacing: '0.5px' }} className="display-font">
              PROPOSED REPLACEMENT — review then Accept (buffer only) or Reject. Save still writes to disk.
            </div>
            <div style={{ border: '1px solid var(--color-border-hairline)', borderRadius: '4px', overflow: 'auto', maxHeight: '300px' }}>
              <DiffView patch={patch} hideToolbar emptyText="No change proposed." />
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={accept} data-help="aiedit.accept" className="display-font" style={{ ...retryStyle, color: 'var(--color-success)', borderColor: 'var(--color-success)' }}>ACCEPT</button>
              <button onClick={reset} data-help="aiedit.reject" className="display-font" style={{ ...retryStyle, color: 'var(--color-fg-muted)' }}>REJECT</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const retryStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary-dim)',
  cursor: 'pointer',
  fontSize: '10px',
  padding: '5px 12px',
  letterSpacing: '1px',
};
