import { useEffect, useState } from 'react';
import type { JobState } from '../../stores/appStore';
import type { KnowledgeArticle, ProviderName, ModelName, EffortLevel } from '@archon/shared';
import { useKnowledgeDistillStore } from '../../stores/knowledgeDistillStore';

// WORKBENCH_EXPANSION_PLAN.md §B3 — "Add from…" wizard.
//
// Three sources, all converging on the SAME editable draft fields the operator
// then Saves:
//   (a) blank            — empty draft.
//   (b) quick link       — paste a URL + manually type/paste a title + summary.
//        DEFERRED auto-fetch (manual quick-link): Archon has no SSRF-guarded
//        fetch helper yet (same posture as D1's @url:). We do NOT fetch the URL
//        server-side — shipping an unreviewed SSRF surface in this phase is out.
//        The operator pastes the URL into the body and writes the summary.
//   (c) distill from this session — an agent DRAFTS an article from the current
//        transcript (WS → knowledge_distill_*). The agent ONLY drafts; this
//        wizard shows the draft in editable fields and the operator must click
//        Save. THE FENCE: nothing is auto-saved; the only persist path is the
//        operator's explicit Save (POST /api/knowledge via onSave).

type WizardMode = 'pick' | 'blank' | 'link' | 'distill';

interface DraftFields {
  title: string;
  body: string;
  tags: string;
  alwaysInclude: boolean;
}

const EMPTY: DraftFields = { title: '', body: '', tags: '', alwaysInclude: false };

export function KnowledgeWizard({
  job,
  editing,
  onSave,
  onClose,
}: {
  job: JobState;
  // When set, the wizard opens in edit mode on an existing article (Save = PATCH).
  editing?: KnowledgeArticle | null;
  onSave: (
    fields: { title: string; body: string; tags: string[]; alwaysInclude: boolean },
    editingId?: string,
  ) => Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<WizardMode>(editing ? 'blank' : 'pick');
  const [fields, setFields] = useState<DraftFields>(
    editing
      ? { title: editing.title, body: editing.body, tags: editing.tags.join(', '), alwaysInclude: editing.alwaysInclude }
      : EMPTY,
  );
  const [saving, setSaving] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');

  const distill = useKnowledgeDistillStore((s) => s.byWorkflow[job.id]);
  const dispatchDistill = useKnowledgeDistillStore((s) => s.dispatch);
  const clearDistill = useKnowledgeDistillStore((s) => s.clear);

  // When a distill proposal lands, fold it into the editable fields.
  useEffect(() => {
    if (mode !== 'distill' || !distill || distill.status !== 'proposed') return;
    setFields((f) => ({
      ...f,
      title: distill.title || f.title,
      body: distill.body || f.body,
      tags: distill.tags.length ? distill.tags.join(', ') : f.tags,
    }));
  }, [mode, distill]);

  const startDistill = () => {
    const c = job.config;
    dispatchDistill({
      workflowId: job.id,
      drafter: {
        provider: (c.primaryProvider ?? 'claude') as ProviderName,
        model: (c.primaryModel ?? 'sonnet') as ModelName,
        effort: (c.primaryEffort ?? 'medium') as EffortLevel,
        providerAccountRef: c.providerAccountRef,
      },
    });
  };

  const insertLink = () => {
    const u = linkUrl.trim();
    if (!u) return;
    setFields((f) => ({
      ...f,
      title: f.title || u,
      body: (f.body ? f.body + '\n\n' : '') + `Source: ${u}\n\n`,
    }));
  };

  const doSave = async () => {
    if (!fields.title.trim() && !fields.body.trim()) return;
    setSaving(true);
    try {
      await onSave(
        {
          title: fields.title,
          body: fields.body,
          tags: fields.tags.split(',').map((t) => t.trim()).filter(Boolean),
          alwaysInclude: fields.alwaysInclude,
        },
        editing?.id,
      );
      clearDistill(job.id);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  // Source picker (only for a fresh article).
  if (mode === 'pick') {
    return (
      <div style={panelStyle}>
        <Header label="ADD ARTICLE" onClose={onClose} />
        <p style={hintStyle}>Build up operator-owned project knowledge — a curated companion to CLAUDE.md.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '0 12px' }}>
          <SourceButton helpKey="rightpanel.knowledge.add-blank" label="Blank article" desc="Write it yourself." onClick={() => setMode('blank')} />
          <SourceButton helpKey="rightpanel.knowledge.add-link" label="Quick link" desc="Paste a URL + a short summary you write." onClick={() => setMode('link')} />
          <SourceButton helpKey="rightpanel.knowledge.add-distill" label="Distill from this session" desc="An agent drafts from the transcript; you edit + Save." onClick={() => { setMode('distill'); startDistill(); }} />
        </div>
      </div>
    );
  }

  const distilling = mode === 'distill' && distill?.status === 'pending';
  const distillError = mode === 'distill' && distill?.status === 'error' ? distill.error : undefined;

  return (
    <div style={panelStyle}>
      <Header label={editing ? 'EDIT ARTICLE' : 'NEW ARTICLE'} onClose={onClose} />

      {mode === 'link' && (
        <div style={{ padding: '0 12px 8px', display: 'flex', gap: '6px' }}>
          <input
            data-help="rightpanel.knowledge.link-url"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://… (manual — not fetched)"
            style={inputStyle}
          />
          <button onClick={insertLink} style={smallBtnStyle}>ADD</button>
        </div>
      )}

      {mode === 'distill' && (
        <div style={{ padding: '0 12px 8px', fontSize: '11px', color: 'var(--color-fg-muted)' }}>
          {distilling && 'Drafting from this session… the agent only proposes — you edit and Save below.'}
          {distillError && <span style={{ color: 'var(--color-danger, #d66)' }}>Draft failed: {distillError}</span>}
          {distill?.status === 'proposed' && 'Draft ready — review, edit, then Save. Nothing is saved until you click Save.'}
        </div>
      )}

      <div style={{ padding: '0 12px', display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, overflowY: 'auto' }}>
        <input
          data-help="rightpanel.knowledge.field-title"
          value={fields.title}
          onChange={(e) => setFields((f) => ({ ...f, title: e.target.value }))}
          placeholder="Title"
          style={inputStyle}
        />
        <textarea
          data-help="rightpanel.knowledge.field-body"
          value={fields.body}
          onChange={(e) => setFields((f) => ({ ...f, body: e.target.value }))}
          placeholder="Markdown body — the durable fact / steps / gotcha."
          style={{ ...inputStyle, minHeight: '180px', resize: 'vertical', fontFamily: 'var(--font-mono, monospace)' }}
        />
        <input
          data-help="rightpanel.knowledge.field-tags"
          value={fields.tags}
          onChange={(e) => setFields((f) => ({ ...f, tags: e.target.value }))}
          placeholder="tags, comma, separated"
          style={inputStyle}
        />
        <label data-help="rightpanel.knowledge.always-include" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--color-fg)' }}>
          <input
            type="checkbox"
            checked={fields.alwaysInclude}
            onChange={(e) => setFields((f) => ({ ...f, alwaysInclude: e.target.checked }))}
          />
          Always include in context (folds into every turn's system prompt, bounded)
        </label>
      </div>

      <div style={{ padding: '8px 12px', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={smallBtnStyle}>CANCEL</button>
        <button
          data-help="rightpanel.knowledge.save"
          onClick={doSave}
          disabled={saving || distilling || (!fields.title.trim() && !fields.body.trim())}
          style={{ ...smallBtnStyle, opacity: saving || distilling ? 0.5 : 1, borderColor: 'var(--color-accent-primary)' }}
        >
          {saving ? 'SAVING…' : 'SAVE'}
        </button>
      </div>
    </div>
  );
}

function Header({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <div className="display-font" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 12px 8px', fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)' }}>
      <span>{label}</span>
      <button onClick={onClose} style={{ ...smallBtnStyle, padding: '1px 6px' }}>✕</button>
    </div>
  );
}

function SourceButton({ label, desc, onClick, helpKey }: { label: string; desc: string; onClick: () => void; helpKey: string }) {
  return (
    <button
      data-help={helpKey}
      onClick={onClick}
      style={{ textAlign: 'left', background: 'transparent', border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg)', cursor: 'pointer', padding: '8px 10px', borderRadius: '3px' }}
    >
      <div style={{ fontSize: '12px', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', marginTop: '2px' }}>{desc}</div>
    </button>
  );
}

const panelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, paddingTop: '8px' };
const hintStyle: React.CSSProperties = { padding: '0 12px 8px', fontSize: '11px', color: 'var(--color-fg-muted)' };
const inputStyle: React.CSSProperties = { flex: 1, background: 'var(--color-bg-input, var(--color-bg))', border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg)', fontSize: '12px', padding: '5px 7px', borderRadius: '3px', fontFamily: 'var(--font-body)' };
const smallBtnStyle: React.CSSProperties = { background: 'transparent', border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px', padding: '3px 8px', fontFamily: 'var(--font-display)' };
