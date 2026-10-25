import { useMemo, useState } from 'react';
import type { WorkflowConfig, ProviderName, ModelName, EffortLevel } from '@archon/shared';
import { RunAsPicker, spawnConfigFromRunAs, type RunAsSelection } from './RunAsPicker';

// Composer-button sibling for REVIEW / HANDOFF / SPAWN / PLAN. One-click
// path to "update the repo's documentation" with a load-bearing prompt
// that explicitly tells the agent NOT to touch `.archon/plans/` (the
// foot-gun that originally motivated this button — Qwen rewriting a
// plan as prose, stripping the checkbox structure the Plan tab parses).
//
// Optional operator note gets appended verbatim — useful for "focus on
// the auth changes" or "leave README alone, just DEVLOG". Without a note,
// the base prompt is sent as-is.

interface Props {
  parentConfig: WorkflowConfig;
  // Same-tab dispatch (when RUN AS == current primary).
  onConfirm: (prompt: string) => void;
  // New-tab spawn (when RUN AS picks a different model).
  onSpawn: (newConfig: WorkflowConfig, newDirection: string, includePlan: boolean) => void;
  onCancel: () => void;
}

const BASE_PROMPT = `Update the repo's documentation to reflect recent changes.

**Process:**
1. Check what's changed: \`git log --oneline -20\`, \`git status\`, and \`git diff main...HEAD\` if on a branch.
2. Identify which markdown docs reference the changed code or describe behavior that's been altered. Common locations: \`README.md\`, \`DEVLOG.md\`, \`CLAUDE.md\`, \`AGENTS.md\`, \`docs/**/*.md\`.
3. Update only those docs. Be precise — change the parts that are now stale; don't rewrite sections that are still accurate.

**Constraints:**
- **DO NOT modify any file under \`.archon/plans/\`.** Plan files are managed separately by the operator and have load-bearing structure (checkboxes, H3 phase headings) that the Plan tab parses to power per-phase review, custom-review picker, and spawn-from-task. Touching them breaks those features. If something in a plan looks stale, mention it in your summary so I can fix it manually.
- Don't add new doc files unless something genuinely requires a new doc. Update existing docs in place.
- Don't restate what the code already says clearly. Docs capture HOW/WHY for someone who hasn't read the code.
- If you spot sections referencing things that no longer exist, flag them or fix them.

When done, summarize which files you updated and what changed in each so I can review.`;

export function DocsUpdateDialog({ parentConfig, onConfirm, onSpawn, onCancel }: Props) {
  const [note, setNote] = useState('');
  const currentPrimary: RunAsSelection = useMemo(() => ({
    provider: (parentConfig.primaryProvider ?? 'claude') as ProviderName,
    model: parentConfig.primaryModel as ModelName,
    effort: parentConfig.primaryEffort as EffortLevel,
    providerAccountRef: parentConfig.providerAccountRef,
  }), [parentConfig.primaryProvider, parentConfig.primaryModel, parentConfig.primaryEffort, parentConfig.providerAccountRef]);
  const [runAs, setRunAs] = useState<RunAsSelection>(currentPrimary);
  const isCurrentPrimary = runAs.provider === currentPrimary.provider && runAs.model === currentPrimary.model && runAs.effort === currentPrimary.effort && runAs.providerAccountRef === currentPrimary.providerAccountRef;

  const send = () => {
    const trimmed = note.trim();
    const prompt = trimmed ? `${BASE_PROMPT}\n\n**Operator note:** ${trimmed}` : BASE_PROMPT;
    if (isCurrentPrimary) {
      onConfirm(prompt);
    } else {
      const newConfig = spawnConfigFromRunAs(parentConfig, runAs, 'docs');
      onSpawn(newConfig, prompt, false);
    }
  };
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-accent-primary-dim)',
          borderRadius: '6px',
          padding: '18px 22px',
          width: 'min(520px, 94vw)',
          fontFamily: 'var(--font-body)',
        }}
      >
        <div
          className="display-font"
          style={{
            fontSize: '12px',
            letterSpacing: '3px',
            color: 'var(--color-accent-primary)',
            marginBottom: '6px',
          }}
        >
          UPDATE REPO DOCS
        </div>
        <div
          style={{
            fontSize: '11px',
            color: 'var(--color-fg-muted)',
            lineHeight: 1.5,
            marginBottom: '12px',
          }}
        >
          Sends the current agent a structured prompt to update README, DEVLOG, CLAUDE.md, and other markdown docs based on recent git activity. <strong style={{ color: 'var(--color-warning)' }}>Plan files under <code>.archon/plans/</code> are explicitly excluded.</strong>
        </div>
        <div style={{ marginBottom: '12px' }}>
          <RunAsPicker current={currentPrimary} selection={runAs} onChange={setRunAs} />
        </div>

        <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '4px' }}>
          OPTIONAL NOTE
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. focus on the auth changes from yesterday — leave README alone"
          rows={3}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '6px 8px',
            background: 'var(--color-bg-sunken)',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            color: 'var(--color-accent-primary)',
            fontFamily: 'var(--font-body)',
            fontSize: '11px',
            resize: 'vertical',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
          <Btn onClick={onCancel}>CANCEL</Btn>
          <Btn primary onClick={send}>{isCurrentPrimary ? 'SEND TO AGENT' : 'SEND (NEW TAB)'}</Btn>
        </div>
      </div>
    </div>
  );
}

function Btn({ onClick, children, primary }: { onClick: () => void; children: React.ReactNode; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className="display-font"
      style={{
        padding: '6px 14px',
        background: primary ? 'var(--color-accent-primary-a10)' : 'transparent',
        border: `1px solid ${primary ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
        borderRadius: '3px',
        color: primary ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
        cursor: 'pointer',
        fontSize: '11px',
        letterSpacing: '2px',
      }}
    >
      {children}
    </button>
  );
}
