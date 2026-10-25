// GENESIS tab (ARCO_OPS_PLAN.md M2 + M3). The operator's seed editor for Genesis.
// Two flows share this tab:
//
//   M2 — from-nothing: a genesis workflow living in its scratch ideation dir. Edit
//   the staged narrative fields (+ stack / scope / GitHub) and run CREATE & SCAFFOLD,
//   which creates a real project dir and rebinds the workflow's cwd to it.
//
//   M3 — in-workflow Creative mode: an EXISTING real-cwd workflow exploring an
//   alternative direction. The operator ARMS Creative mode (server snapshots the
//   project context + assesses codebase size), edits the alternative seed, and runs
//   CREATE ALTERNATIVE — which scaffolds into a sibling `ALTERNATIVE/<slug>/` dir and
//   a separate plan WITHOUT touching the existing project. A large/established
//   codebase shows the operator's stated late-stage warning + a Spawn-from-here hint.
//
// The operator is the only editor of the seed (no transcript auto-extraction — that
// would be a second-model pattern outside the fences), so local state is
// authoritative; field edits debounce a `genesis_seed_update` to the server, which
// echoes back readiness + the next prompt (rendered from the live job state).

import { useEffect, useRef, useState } from 'react';
import type { GenesisAssistField, GenesisAssistIntent, GenesisNameOption, GenesisSeed } from '@arco/shared';
import type { JobState } from '../../stores/appStore';
import { useAppStore } from '../../stores/appStore';

interface Props {
  job: JobState;
  onSeedUpdate?: (workflowId: string, seed: GenesisSeed) => void;
  onScaffold?: (workflowId: string, root?: string, github?: { create: boolean; visibility: 'private' | 'public'; repoName?: string }) => void;
  onCreativeArm?: (workflowId: string, disarm?: boolean) => void;
  onAssistRequest?: (workflowId: string, requestId: string, field: GenesisAssistField, intent: GenesisAssistIntent, seed: GenesisSeed, instruction?: string) => void;
}

const label: React.CSSProperties = {
  fontSize: '10px',
  letterSpacing: '2px',
  color: 'var(--color-accent-primary-dim)',
  display: 'block',
  marginBottom: '4px',
  fontFamily: 'var(--font-display)',
};
const input: React.CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  background: 'var(--color-bg-sunken)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '4px',
  color: 'var(--color-accent-primary)',
  fontFamily: 'var(--font-body)',
  fontSize: '13px',
  outline: 'none',
  boxSizing: 'border-box',
};
const area: React.CSSProperties = { ...input, resize: 'vertical', minHeight: '64px' };

const SCRATCH_RE = /[\\/]\.arco[\\/]genesis[\\/]/;

const emptySeed = (): GenesisSeed => ({ title: '', spark: '', concept: '', theCase: '', buildDirection: '' });
const emptyNameWorkbench = () => ({ shortlisted: [] as string[], rejected: [] as string[] });

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function addUniqueName(list: string[], name: string): string[] {
  const clean = name.trim();
  if (!clean) return list;
  return list.some((n) => sameName(n, clean)) ? list : [...list, clean];
}

function assistLabel(intent: GenesisAssistIntent): string {
  switch (intent) {
    case 'fresh': return 'WRITE';
    case 'expand': return 'EXPAND';
    case 'name': return 'NAME';
    case 'stack': return 'STACK';
    case 'scope': return 'SCOPE';
    default: return 'IMPROVE';
  }
}

const miniBtn: React.CSSProperties = {
  padding: '3px 6px',
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-fg-muted)',
  cursor: 'pointer',
  fontFamily: 'var(--font-display)',
  fontSize: '9px',
  letterSpacing: '1px',
};

export function GenesisTab({ job, onSeedUpdate, onScaffold, onCreativeArm, onAssistRequest }: Props) {
  const seed = job.genesisSeed;
  const cwd = job.config.workingDirectory ?? '';
  const inScratch = SCRATCH_RE.test(cwd);
  const creative = !!seed?.creative;               // M3 armed
  const canArm = !inScratch && cwd.trim().length > 0 && !creative; // M3 not-yet-armed

  // Local editor state. Seeded from the workflow's seed on mount/tab-switch, and once
  // more when a seed first ARRIVES (arming a previously-seedless workflow) so the
  // prefilled context lands — but never re-seeded on later server echoes, so they
  // can't yank the operator's cursor mid-edit.
  const [draft, setDraft] = useState<GenesisSeed>(() => seed ?? emptySeed());
  const [root, setRoot] = useState('~/Projects');
  const [createRepo, setCreateRepo] = useState(false);
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [repoName, setRepoName] = useState('');
  const [refineInstruction, setRefineInstruction] = useState('');
  const clearGenesisAssist = useAppStore((s) => s.clearGenesisAssist);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jobIdRef = useRef(job.id);
  const hadSeedRef = useRef(!!seed);

  useEffect(() => {
    if (jobIdRef.current !== job.id) {
      jobIdRef.current = job.id;
      setDraft(job.genesisSeed ?? emptySeed());
      hadSeedRef.current = !!job.genesisSeed;
      return;
    }
    if (!hadSeedRef.current && job.genesisSeed) {
      setDraft(job.genesisSeed);
      hadSeedRef.current = true;
    }
  }, [job.id, job.genesisSeed]);

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  // M3 — the arm panel: a real-cwd workflow that has not yet opted into Creative mode.
  if (canArm) {
    return (
      <div data-help="rightpanel.genesis.creative" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div className="display-font glow-text-bright" style={{ fontSize: '13px', letterSpacing: '3px', color: 'var(--color-accent-primary)' }}>
          GENESIS · CREATIVE MODE
        </div>
        <div style={{ fontSize: '12px', color: 'var(--color-fg-muted)', lineHeight: 1.6 }}>
          Explore an <strong>alternative direction</strong> for this project using the staged Genesis process —
          right here in this workflow. Arming snapshots the current project as grounding context and runs the
          Spark → Concept → Case → Build-direction conversation toward a different take.
        </div>
        <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', lineHeight: 1.6, borderLeft: '2px solid var(--color-border-hairline)', paddingLeft: '10px' }}>
          Creative mode never edits the existing project. A scaffold lands in a sibling
          <code> ALTERNATIVE/</code> folder with its own plan; if the idea diverges sharply you can
          Spawn-from-here to fork it into a fresh tab.
        </div>
        <button
          onClick={() => onCreativeArm?.(job.id)}
          className="glow-border"
          style={{
            padding: '9px 16px',
            background: 'var(--color-accent-primary-a08)',
            border: '1px solid var(--color-accent-primary)',
            borderRadius: '4px',
            color: 'var(--color-accent-primary)',
            cursor: 'pointer',
            fontFamily: 'var(--font-display)',
            fontSize: '12px',
            letterSpacing: '2px',
            alignSelf: 'flex-start',
          }}
        >
          ARM CREATIVE MODE
        </button>
      </div>
    );
  }

  if (!seed) {
    return <div style={{ padding: '16px', color: 'var(--color-fg-muted)', fontSize: '12px' }}>No genesis seed for this workflow.</div>;
  }

  // Patch a field, then debounce the seed update to the server (300ms).
  const patch = (next: Partial<GenesisSeed>, immediate = false) => {
    const merged = { ...draft, ...next };
    setDraft(merged);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (immediate) {
      onSeedUpdate?.(job.id, merged);
    } else {
      debounceRef.current = setTimeout(() => onSeedUpdate?.(job.id, merged), 300);
    }
  };

  const askAssist = (field: GenesisAssistField, intent: GenesisAssistIntent, instruction?: string) => {
    const requestId = crypto.randomUUID();
    setRefineInstruction('');
    onAssistRequest?.(job.id, requestId, field, intent, draft, instruction);
  };

  const applyAssist = () => {
    const assist = job.genesisAssist;
    if (!assist?.suggestion || assist.status !== 'proposed') return;
    patch({ [assist.field]: assist.suggestion } as Partial<GenesisSeed>);
    clearGenesisAssist(job.id, assist.requestId);
  };

  const nameWorkbench = draft.nameWorkbench ?? emptyNameWorkbench();
  const setNameState = (name: string, action: 'shortlist' | 'reject' | 'use') => {
    const clean = name.trim();
    if (!clean) return;
    const current = draft.nameWorkbench ?? emptyNameWorkbench();
    const next = action === 'reject'
      ? {
          shortlisted: current.shortlisted.filter((n) => !sameName(n, clean)),
          rejected: addUniqueName(current.rejected, clean),
        }
      : {
          shortlisted: addUniqueName(current.shortlisted, clean),
          rejected: current.rejected.filter((n) => !sameName(n, clean)),
        };
    patch(action === 'use' ? { title: clean, nameWorkbench: next } : { nameWorkbench: next }, true);
  };

  const nameStatus = (name: string): 'shortlisted' | 'rejected' | null => {
    if (nameWorkbench.shortlisted.some((n) => sameName(n, name))) return 'shortlisted';
    if (nameWorkbench.rejected.some((n) => sameName(n, name))) return 'rejected';
    return null;
  };

  const refineAssist = () => {
    const assist = job.genesisAssist;
    if (!assist) return;
    const optionContext = assist.field === 'title' && assist.options?.length
      ? `Previous name options: ${assist.options.map((o) => o.name).join(', ')}.`
      : '';
    const historyContext = assist.field === 'title'
      ? `Shortlisted names: ${nameWorkbench.shortlisted.join(', ') || '(none)'}. Rejected names: ${nameWorkbench.rejected.join(', ') || '(none)'}.`
      : '';
    const instruction = [optionContext, historyContext, refineInstruction || 'Refine the prior suggestion.']
      .filter((x) => x.trim().length > 0)
      .join('\n');
    askAssist(assist.field, assist.intent, instruction);
  };

  const readiness = job.genesisReadiness;
  const scaffolded = job.genesisScaffold;
  const codebase = job.genesisCodebase;

  const doScaffold = () => {
    if (!draft.title.trim()) return;
    if (creative) {
      const ok = window.confirm(
        `Scaffold an alternative direction into a new ALTERNATIVE/${draft.title.trim()} folder inside this project, plus a separate plan?\n\nThis creates files in a sibling folder only — your existing project is not touched.`,
      );
      if (!ok) return;
      onScaffold?.(job.id); // server branches on seed.creative — no root / github
      return;
    }
    const ok = window.confirm(
      `Create the project folder under ${root || '~/Projects'} (named from "${draft.title.trim()}"), write the seed docs${createRepo ? ` and a ${visibility} GitHub repo` : ''}, and bind this workflow to it?\n\nThis creates files on disk.`,
    );
    if (!ok) return;
    onScaffold?.(job.id, root.trim() || undefined, createRepo ? { create: true, visibility, ...(repoName.trim() ? { repoName: repoName.trim() } : {}) } : undefined);
  };

  const aiButtons = (field: GenesisAssistField, intents: GenesisAssistIntent[] = ['improve', 'fresh', 'expand']) => (
    <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
      {intents.map((intent) => (
        <button
          key={`${field}:${intent}`}
          type="button"
          onClick={() => askAssist(field, intent)}
          disabled={job.genesisAssist?.status === 'running'}
          style={{ ...miniBtn, opacity: job.genesisAssist?.status === 'running' ? 0.5 : 1 }}
          title={`Ask AI to ${assistLabel(intent).toLowerCase()} ${field}`}
        >
          {assistLabel(intent)}
        </button>
      ))}
    </div>
  );

  const field = (key: GenesisAssistField, title: string, placeholder: string, big = false, intents?: GenesisAssistIntent[]) => (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '4px' }}>
        <label style={{ ...label, marginBottom: 0 }}>{title}</label>
        {aiButtons(key, intents)}
      </div>
      <textarea
        value={(draft[key] as string) ?? ''}
        onChange={(e) => patch({ [key]: e.target.value } as Partial<GenesisSeed>)}
        placeholder={placeholder}
        rows={big ? 4 : 2}
        style={big ? { ...area, minHeight: '88px' } : area}
      />
    </div>
  );

  return (
    <div style={{ padding: '12px 14px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {/* Readiness + next-field guidance */}
      <div data-help="rightpanel.genesis.readiness" style={{ border: '1px solid var(--color-border-hairline)', borderRadius: '6px', padding: '10px 12px' }}>
        <div className="display-font glow-text-bright" style={{ fontSize: '13px', letterSpacing: '3px', color: 'var(--color-accent-primary)', marginBottom: '6px' }}>
          GENESIS{creative ? ' · CREATIVE' : ''}{readiness ? ` · ${readiness.stage.toUpperCase()}` : ''}
        </div>
        {readiness && (
          <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
            {readiness.readyToScaffold
              ? 'Every stage is filled — ready to scaffold.'
              : readiness.missing.length > 0
                ? `Toward ${readiness.nextStage}: ${readiness.missing.join('; ')}`
                : 'Ready to advance when you are.'}
          </div>
        )}
        {job.genesisNextPrompt && (
          <div style={{ fontSize: '11px', color: 'var(--color-accent-secondary)', fontStyle: 'italic', marginTop: '6px' }}>
            {job.genesisNextPrompt}
          </div>
        )}
      </div>

      {/* M3 — established-codebase warning (the operator's stated late-stage guardrail) */}
      {creative && codebase?.warning && (
        <div data-help="rightpanel.genesis.creative" style={{ border: '1px solid var(--color-warning)', borderRadius: '6px', padding: '10px 12px', background: 'var(--color-warning-a08, transparent)' }}>
          <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-warning)', marginBottom: '5px' }}>ESTABLISHED CODEBASE</div>
          <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>{codebase.warning}</div>
          <button
            onClick={() => onCreativeArm?.(job.id, true)}
            style={{ marginTop: '8px', padding: '4px 10px', background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '4px', color: 'var(--color-fg-muted)', cursor: 'pointer', fontFamily: 'var(--font-display)', fontSize: '10px', letterSpacing: '2px' }}
          >
            DISARM
          </button>
        </div>
      )}

      {job.genesisAssist && (
        <div style={{ border: `1px solid ${job.genesisAssist.status === 'error' ? 'var(--color-warning)' : 'var(--color-accent-secondary-dim)'}`, borderRadius: '6px', padding: '10px 12px', background: 'var(--color-bg-sunken)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: job.genesisAssist.status === 'error' ? 'var(--color-warning)' : 'var(--color-accent-secondary)' }}>
            AI FIELD ASSIST · {String(job.genesisAssist.field).toUpperCase()}
          </div>
          {job.genesisAssist.status === 'running' && (
            <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)' }}>Running the current primary agent for a field suggestion…</div>
          )}
          {job.genesisAssist.status === 'error' && (
            <>
              <div style={{ fontSize: '11px', color: 'var(--color-warning)', lineHeight: 1.5 }}>{job.genesisAssist.error}</div>
              <button type="button" onClick={() => clearGenesisAssist(job.id, job.genesisAssist?.requestId)} style={{ ...miniBtn, alignSelf: 'flex-start' }}>DISMISS</button>
            </>
          )}
          {job.genesisAssist.status === 'proposed' && (
            <>
              {job.genesisAssist.field === 'title' && job.genesisAssist.options?.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                  <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>Name candidates</div>
                  {job.genesisAssist.options.map((option: GenesisNameOption) => {
                    const status = nameStatus(option.name);
                    return (
                      <div key={option.name} style={{ border: '1px solid var(--color-border-hairline)', borderRadius: '4px', padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
                          <div style={{ fontSize: '13px', color: 'var(--color-accent-primary)', fontWeight: 700 }}>{option.name}</div>
                          {status && <div className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: status === 'shortlisted' ? 'var(--color-accent-secondary)' : 'var(--color-warning)' }}>{status.toUpperCase()}</div>}
                        </div>
                        {option.rationale && <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', lineHeight: 1.45 }}>{option.rationale}</div>}
                        <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                          <button type="button" onClick={() => setNameState(option.name, 'use')} style={{ ...miniBtn, color: 'var(--color-accent-primary)', borderColor: 'var(--color-accent-primary)' }}>USE</button>
                          <button type="button" onClick={() => setNameState(option.name, 'shortlist')} style={miniBtn}>SHORTLIST</button>
                          <button type="button" onClick={() => setNameState(option.name, 'reject')} style={miniBtn}>REJECT</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <>
                  <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>Suggested value</div>
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: '12px', color: 'var(--color-fg-secondary)', lineHeight: 1.5, border: '1px solid var(--color-border-hairline)', borderRadius: '4px', padding: '8px' }}>
                    {job.genesisAssist.suggestion}
                  </div>
                </>
              )}
              {job.genesisAssist.rationale && (
                <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontStyle: 'italic', lineHeight: 1.5 }}>{job.genesisAssist.rationale}</div>
              )}
              {job.genesisAssist.field === 'title' && (
                <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
                  Shortlisted: {nameWorkbench.shortlisted.length ? nameWorkbench.shortlisted.join(', ') : 'none'} · Rejected: {nameWorkbench.rejected.length ? nameWorkbench.rejected.join(', ') : 'none'}
                </div>
              )}
              <textarea
                value={refineInstruction}
                onChange={(e) => setRefineInstruction(e.target.value)}
                placeholder={job.genesisAssist.field === 'title' ? 'Refine instruction, e.g. shortlist Lucent but give me more mythic options…' : 'Refine instruction, e.g. make it more technical or more concrete…'}
                rows={2}
                style={{ ...area, minHeight: '52px', fontSize: '12px' }}
              />
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {!(job.genesisAssist.field === 'title' && job.genesisAssist.options?.length) && (
                  <button type="button" onClick={applyAssist} style={{ ...miniBtn, color: 'var(--color-accent-primary)', borderColor: 'var(--color-accent-primary)' }}>APPLY</button>
                )}
                <button type="button" onClick={refineAssist} style={miniBtn}>
                  REFINE
                </button>
                <button type="button" onClick={() => clearGenesisAssist(job.id, job.genesisAssist?.requestId)} style={miniBtn}>REJECT</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Seed editor */}
      <div data-help="rightpanel.genesis.seed" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '4px' }}>
            <label style={{ ...label, marginBottom: 0 }}>WORKING NAME</label>
            {aiButtons('title', ['name', 'improve'])}
          </div>
          <input value={draft.title} onChange={(e) => patch({ title: e.target.value })} placeholder="Project name" style={input} />
          {(nameWorkbench.shortlisted.length > 0 || nameWorkbench.rejected.length > 0) && (
            <div style={{ marginTop: '6px', fontSize: '10px', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
              {nameWorkbench.shortlisted.length > 0 && <>Shortlisted: {nameWorkbench.shortlisted.join(', ')}</>}
              {nameWorkbench.shortlisted.length > 0 && nameWorkbench.rejected.length > 0 && <> · </>}
              {nameWorkbench.rejected.length > 0 && <>Rejected: {nameWorkbench.rejected.join(', ')}</>}
            </div>
          )}
        </div>
        {field('spark', 'THE SPARK', 'The raw idea, in your own words.', true)}
        {field('concept', 'CONCEPT', 'What this thing is, in plain language — built from the Spark.')}
        {field('theCase', 'THE CASE', 'Why building this is worth it; who it is for; where scope stops.')}
        {field('buildDirection', 'BUILD DIRECTION', 'Stack direction, scope boundaries, first concrete steps.', true)}
        <div style={{ display: 'flex', gap: '10px' }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '4px' }}>
              <label style={{ ...label, marginBottom: 0 }}>STACK (optional)</label>
              {aiButtons('stack', ['stack', 'improve'])}
            </div>
            <input value={draft.stack ?? ''} onChange={(e) => patch({ stack: e.target.value })} placeholder="e.g. Node + TS" style={input} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '4px' }}>
              <label style={{ ...label, marginBottom: 0 }}>SCOPE (optional)</label>
              {aiButtons('scope', ['scope', 'improve'])}
            </div>
            <input value={draft.scope ?? ''} onChange={(e) => patch({ scope: e.target.value })} placeholder="e.g. local-only v0" style={input} />
          </div>
        </div>
      </div>

      {/* Scaffold */}
      <div data-help="rightpanel.genesis.scaffold" style={{ border: '1px solid var(--color-border-hairline)', borderRadius: '6px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div className="display-font" style={{ fontSize: '12px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)' }}>
          {creative ? 'CREATE ALTERNATIVE' : 'CREATE & SCAFFOLD'}
        </div>
        {creative ? (
          <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
            Writes into <code>ALTERNATIVE/{draft.title.trim() ? draft.title.trim() : '…'}</code> inside this project, with a
            separate plan. Your existing files stay untouched.
          </div>
        ) : (
          <>
            <div>
              <label style={label}>PARENT FOLDER</label>
              <input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="~/Projects" style={input} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--color-fg-muted)', cursor: 'pointer' }}>
              <input type="checkbox" checked={createRepo} onChange={(e) => setCreateRepo(e.target.checked)} />
              Create a GitHub repo (via gh)
            </label>
            <div>
              <label style={label}>GITHUB VISIBILITY</label>
              <select
                value={visibility}
                disabled={!createRepo}
                onChange={(e) => setVisibility(e.target.value as 'private' | 'public')}
                style={{ ...input, opacity: createRepo ? 1 : 0.45 }}
              >
                <option value="private">private</option>
                <option value="public">public</option>
              </select>
              {!createRepo && (
                <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', marginTop: '4px' }}>
                  Used only when GitHub repo creation is checked.
                </div>
              )}
            </div>
            {createRepo && (
              <div>
                <label style={label}>GITHUB REPO NAME (optional)</label>
                <input value={repoName} onChange={(e) => setRepoName(e.target.value)} placeholder="Defaults to project folder name" style={input} />
              </div>
            )}
            <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
              Creates a fresh project folder and writes <code>README.md</code>, <code>SPEC.md</code>, <code>TODO.md</code>, <code>.gitignore</code>, and local gitignored agent notes for Claude, Codex, and Gemini. Git is initialized best-effort. If GitHub is checked, Arco runs <code>gh repo create</code> with the selected visibility and pushes the initial commit when local <code>gh</code> auth is available.
            </div>
          </>
        )}
        {scaffolded ? (
          <div style={{ fontSize: '11px', color: 'var(--color-accent-primary)', lineHeight: 1.5 }}>
            {scaffolded.creative ? 'Alternative scaffolded → ' : 'Scaffolded → '}
            {scaffolded.cwd}{scaffolded.creative ? '/ALTERNATIVE' : ''}
            {scaffolded.repoUrl && <> · {scaffolded.repoUrl}</>}
            {scaffolded.repoError && <div style={{ color: 'var(--color-warning)' }}>repo: {scaffolded.repoError}</div>}
            {scaffolded.suggestSpawn && (
              <div style={{ color: 'var(--color-accent-secondary)', marginTop: '4px' }}>
                Use the SPAWN button to fork this direction into a fresh tab.
              </div>
            )}
          </div>
        ) : (
          <button
            onClick={doScaffold}
            disabled={!draft.title.trim()}
            className={draft.title.trim() ? 'glow-border' : ''}
            style={{
              padding: '9px 16px',
              background: draft.title.trim() ? 'var(--color-accent-primary-a08)' : 'transparent',
              border: `1px solid ${draft.title.trim() ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
              borderRadius: '4px',
              color: draft.title.trim() ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: draft.title.trim() ? 'pointer' : 'not-allowed',
              fontFamily: 'var(--font-display)',
              fontSize: '12px',
              letterSpacing: '2px',
            }}
          >
            {creative ? 'CREATE ALTERNATIVE' : 'CREATE & SCAFFOLD'}
          </button>
        )}
      </div>
    </div>
  );
}
