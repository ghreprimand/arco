import { useEffect, useState, type CSSProperties } from 'react';
import { DEFAULT_CODEX_MODEL } from '@arco/shared';
import type { ProviderName, ModelName, EffortLevel, ReviewContextRef, PlanReviewMode } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { effortsForModel, clampEffortForProvider } from '../utils/format';
import { claudeModelLabel, defaultModelForProvider, modelsForProvider, useModelCatalogs } from '../utils/modelCatalog';
import { CursorModelSelect } from './CursorModelSelect';

// Shared look for the Cursor family/effort dropdowns — matches the dialog's
// text inputs (sunken bg, hairline border, accent text).
const cursorSelectStyle: CSSProperties = {
  padding: '5px 8px',
  background: 'var(--color-bg-sunken)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary)',
  fontSize: '11px',
  outline: 'none',
  cursor: 'pointer',
};

interface Props {
  primary: { provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string };
  onConfirm: (
    reviewer: { provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string },
    contextRef: ReviewContextRef,
    includeGitDiff: boolean,
  ) => void;
  onCancel: () => void;
  // When set, the dialog skips the SCOPE picker and uses the supplied
  // plan-* ref instead. The MODE row (VERIFY / CRITIQUE) becomes visible
  // and edits the ref's `mode` field. Used by the plan-tab triggers
  // (per-phase pill, REVIEW PLAN button, CUSTOM REVIEW picker).
  prefilledPlanRef?: Extract<
    ReviewContextRef,
    { kind: 'plan-whole' | 'plan-phase' | 'plan-items' | 'cluster-plan-whole' | 'cluster-plan-phase' }
  >;
  // Phase 8 — when set, the dialog locks scope to the supplied since-event
  // ref. Wired from the HISTORY tab's "REVIEW FROM HERE" button. Mutually
  // exclusive with prefilledPlanRef; if both are set, plan ref wins (the
  // existing plan flow predates this).
  prefilledSinceEventRef?: Extract<ReviewContextRef, { kind: 'since-event' }>;
  // Operator-readable label shown in place of the SCOPE picker when any
  // ref is locked in. Examples: "PLAN: WHOLE", "PLAN PHASE: Phase 4",
  // "FROM 07:39:02 — research checkpoint".
  prefilledScopeLabel?: string;
  // VERIFY WORK / VERIFY PHASE buttons pre-tick INCLUDE GIT DIFF so the
  // reviewer sees the actual changes alongside the claimed-done items
  // without the operator having to remember the toggle. Operator can
  // still untick before confirming.
  initialIncludeGitDiff?: boolean;
  // Cluster reviewer dispatch — when the dialog opens from a cluster member's
  // pane, lets the operator route the review through another cluster member
  // (the member does the work as a normal turn, visible in chat + activity)
  // instead of spawning a one-shot sub-worker. `selfWorkflowId` is the
  // member being reviewed and is excluded from the picker.
  clusterContext?: {
    clusterId: string;
    selfWorkflowId: string;
    members: Array<{ workflowId: string; displayName: string }>;
  };
  // Fires when operator picks a cluster member as reviewer instead of a
  // model. App.tsx is responsible for building the review-task content from
  // the contextRef and dispatching via operator_peer_send.
  onConfirmViaMember?: (
    reviewerWorkflowId: string,
    contextRef: ReviewContextRef,
    includeGitDiff: boolean,
  ) => void;
}

// Operator-visible scope options. `kind` maps 1:1 to the protocol's
// ReviewContextRef; `last-n` carries an editable number alongside.
type ScopeKind = 'last-turn' | 'last-n' | 'current-session' | 'full' | 'git-diff';
const SCOPE_LABELS: Record<ScopeKind, string> = {
  'last-turn': 'LAST TURN',
  'last-n': 'LAST N TURNS',
  'current-session': 'CURRENT SESSION',
  'full': 'FULL TRANSCRIPT',
  'git-diff': 'GIT DIFF ONLY',
};
const SCOPE_HINTS: Record<ScopeKind, string> = {
  'last-turn': 'Only the most recent prompt + reply.',
  'last-n': 'The N most recent completed turns.',
  'current-session': 'Every turn since the last handoff (or from the start).',
  'full': 'Every completed turn in this tab.',
  'git-diff': 'Just `git diff HEAD` — no transcript.',
};

// Cross-family default: Claude primary → Codex reviewer, anything else →
// Claude reviewer. Surfaces a second perspective without extra picker work
// when the operator just wants to ship a review.
function defaultReviewer(primary: Props['primary']): Props['primary'] {
  if (primary.provider === 'claude') {
    return { provider: 'codex', model: DEFAULT_CODEX_MODEL, effort: 'high' };
  }
  return { provider: 'claude', model: 'sonnet', effort: 'high' };
}

export function ReviewDialog({ primary, onConfirm, onCancel, prefilledPlanRef, prefilledSinceEventRef, prefilledScopeLabel, initialIncludeGitDiff, clusterContext, onConfirmViaMember }: Props) {
  const authStatus = useAppStore((s) => s.authStatus);
  const isProviderEnabled = useAppStore((s) => s.isProviderEnabled);
  const settings = useAppStore((s) => s.settings);
  const catalogs = useModelCatalogs();
  const { claude: claudeNativeCatalog, codex: codexCatalog, cursor: cursorCatalog, ollamaModels, llamacppModels, lmstudioModels, strataModels, deepseekModels = [] } = catalogs;
  const def = defaultReviewer(primary);
  const [provider, setProvider] = useState<ProviderName>(def.provider);
  const [model, setModel] = useState<ModelName>(def.model);
  const [effort, setEffort] = useState<EffortLevel>(def.effort);
  const [providerAccountRef, setProviderAccountRef] = useState<string | undefined>(
    def.provider === 'codex' ? primary.providerAccountRef : undefined,
  );
  const codexAccounts = settings?.providerAccounts?.codex ?? [];
  const [scopeKind, setScopeKind] = useState<ScopeKind>('last-turn');
  const [lastN, setLastN] = useState<number>(5);
  const [includeGitDiff, setIncludeGitDiff] = useState<boolean>(initialIncludeGitDiff ?? false);
  const [planMode, setPlanMode] = useState<PlanReviewMode>(prefilledPlanRef?.mode ?? 'verify');
  // Cluster reviewer routing — 'sub-worker' (default) keeps the existing
  // one-shot subprocess path; a wfid routes the review as a peer_send to
  // that cluster member so it does the work as a normal visible turn.
  // For cluster-plan refs (whole/phase), "self" is just an arbitrary routing
  // anchor — the plan body is shared across the cluster, not bound to a
  // specific member's transcript. So every member is a valid reviewer
  // candidate. For other refs (last-turn / last-n / full / git-diff), self
  // IS the target being reviewed, so exclude it.
  const isClusterPlanRef = !!prefilledPlanRef && (
    prefilledPlanRef.kind === 'cluster-plan-whole' || prefilledPlanRef.kind === 'cluster-plan-phase'
  );
  const clusterPeers = (clusterContext?.members ?? [])
    .filter((m) => isClusterPlanRef || m.workflowId !== clusterContext?.selfWorkflowId);
  const [reviewerKind, setReviewerKind] = useState<'sub-worker' | string>('sub-worker');

  const isPlanReview = !!prefilledPlanRef;
  const isSinceEventReview = !isPlanReview && !!prefilledSinceEventRef;
  const isScopeLocked = isPlanReview || isSinceEventReview;
  // git-diff scope can't be peer-routed (the diff lives on the server, not in
  // chat). Force back to sub-worker when operator picks git-diff after a
  // member, so the dispatch doesn't silently send an empty payload.
  const usingMember = reviewerKind !== 'sub-worker';
  useEffect(() => {
    if (!isScopeLocked && scopeKind === 'git-diff' && usingMember) {
      setReviewerKind('sub-worker');
    }
  }, [scopeKind, isScopeLocked, usingMember]);

  const buildContextRef = (): ReviewContextRef => {
    if (prefilledPlanRef) {
      // Carry the picker's selection forward verbatim, swapping in the
      // operator's MODE-row choice. The dialog can flip between verify
      // and critique without going back to the picker.
      return { ...prefilledPlanRef, mode: planMode };
    }
    if (prefilledSinceEventRef) {
      return { ...prefilledSinceEventRef };
    }
    switch (scopeKind) {
      case 'last-turn': return { kind: 'last-turn' };
      case 'last-n': return { kind: 'last-n', n: Math.max(1, Math.min(50, Math.floor(lastN))) };
      case 'current-session': return { kind: 'current-session' };
      case 'full': return { kind: 'full' };
      case 'git-diff': return { kind: 'git-diff' };
    }
  };
  // Git-diff-only scope already IS the diff, so the checkbox collapses
  // to a no-op. Disable it to remove the redundant option. Plan reviews
  // never have this conflict — `git-diff` scope isn't reachable there.
  const gitDiffCheckboxDisabled = !isScopeLocked && scopeKind === 'git-diff';

  // Clamp model to one that actually exists in the current pill set.
  // Catches: dialog opened before catalog loaded (default 'sonnet' alias),
  // catalog arriving mid-render (alias becomes invalid), provider switch
  // mid-edit (model from old provider's pills lingers).
  useEffect(() => {
    const available = modelsForProvider(provider, catalogs);
    if (available.length === 0) return;
    if (!available.includes(model)) {
      setModel(defaultModelForProvider(provider, catalogs));
    }
  }, [provider, model, catalogs]);
  useEffect(() => {
    if (provider !== 'codex') {
      setProviderAccountRef(undefined);
      return;
    }
    if (!providerAccountRef && codexAccounts.length > 0) {
      setProviderAccountRef(primary.provider === 'codex' && primary.providerAccountRef ? primary.providerAccountRef : codexAccounts[0]?.id);
      return;
    }
    if (providerAccountRef && !codexAccounts.some((a) => a.id === providerAccountRef)) {
      setProviderAccountRef(codexAccounts[0]?.id);
    }
  }, [provider, providerAccountRef, codexAccounts, primary.provider, primary.providerAccountRef]);
  const availableProviders = (['claude', 'codex', 'cursor', 'gemini', 'antigravity', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek'] as ProviderName[]).filter((p) => {
    if (!isProviderEnabled(p)) return false;
    // Antigravity auths inside its own desktop app (the Google account signed
    // into the isolated Arco profile), not through Arco's auth service.
    // Trust the operator to have it running; runtime surfaces a clear error
    // if the Antigravity desktop/RPC endpoint is unreachable when the review fires.
    if (p === 'antigravity') return true;
    // Ollama is "logged in" if the daemon is reachable AND has at least one
    // model installed — without a model there's nothing to spawn.
    if (p === 'ollama') return !!authStatus?.ollama?.loggedIn && ollamaModels.length > 0;
    // llama.cpp: binary present + at least one operator-declared model entry.
    if (p === 'llamacpp') return !!authStatus?.llamacpp?.loggedIn && llamacppModels.length > 0;
    // LM Studio: endpoint reachable AND at least one model from /v1/models.
    if (p === 'strata') return !!authStatus?.strata?.loggedIn && strataModels.length > 0;
    if (p === 'deepseek') return !!authStatus?.deepseek?.loggedIn && deepseekModels.length > 0;
    if (p === 'lmstudio') return !!authStatus?.lmstudio?.loggedIn && lmstudioModels.length > 0;
    return !!authStatus?.[p]?.loggedIn;
  });

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
          width: 'min(420px, calc(92vw / var(--ui-scale, 1)))',
          fontFamily: 'var(--font-body)',
        }}
      >
        <div
          className="display-font"
          style={{
            fontSize: '12px',
            letterSpacing: '3px',
            color: 'var(--color-accent-primary)',
            marginBottom: '14px',
          }}
        >
          RUN REVIEW
        </div>

        {clusterContext && clusterPeers.length > 0 && (
          <Field label="STEP 2 — WHO DOES THE REVIEW?" helpKey="review.dispatch">
            <Row>
              <Pill
                active={reviewerKind === 'sub-worker'}
                onClick={() => setReviewerKind('sub-worker')}
                small
              >
                SUB-WORKER
              </Pill>
              {clusterPeers.map((m) => {
                const disabled = !isScopeLocked && scopeKind === 'git-diff';
                return (
                  <Pill
                    key={m.workflowId}
                    active={reviewerKind === m.workflowId}
                    onClick={() => { if (!disabled) setReviewerKind(m.workflowId); }}
                    small
                    title={disabled ? 'git-diff scope only works with sub-worker (server-side diff)' : `Send the review task to ${m.displayName} as a peer message`}
                  >
                    {m.displayName.toUpperCase()}
                  </Pill>
                );
              })}
            </Row>
            <div
              className="display-font"
              style={{ marginTop: '4px', fontSize: '9px', color: 'var(--color-fg-muted)', letterSpacing: '0.5px', lineHeight: 1.5 }}
            >
              {usingMember
                ? 'Cluster member does the review as a normal visible turn — output streams to their chat + activity. No artifact file; findings live in the member\'s chat.'
                : 'One-shot disposable sub-worker (the default). Writes a `.md` artifact; surfaces in the REVIEWS tab.'}
            </div>
          </Field>
        )}

        {!usingMember && (
        <>
        <Field label="REVIEWER PROVIDER" helpKey="review.provider">
          <Row>
            {availableProviders.map((p) => (
              <Pill
                key={p}
                active={provider === p}
                onClick={() => {
                  setProvider(p);
                  if (p === 'codex') {
                    setProviderAccountRef(primary.provider === 'codex' ? primary.providerAccountRef : codexAccounts[0]?.id);
                  } else {
                    setProviderAccountRef(undefined);
                  }
                  if (!modelsForProvider(p, catalogs).includes(model)) setModel(defaultModelForProvider(p, catalogs));
                  setEffort(clampEffortForProvider(effort, p));
                }}
              >
                {p === 'llamacpp' ? 'LLAMA' : p === 'lmstudio' ? 'LM STUDIO' : p === 'antigravity' ? 'ANTIGRAV' : p === 'deepseek' ? 'XOLOTL' : p.toUpperCase()}
              </Pill>
            ))}
          </Row>
        </Field>

        {provider === 'codex' && codexAccounts.length > 0 && (
          <Field label="ACCOUNT" helpKey="review.account">
            <Row>
              {codexAccounts.map((account) => {
                const status = authStatus?.codex?.accountStatuses?.find((s) => s.id === account.id);
                const short = (account.shortLabel || account.label || account.id).slice(0, 4).toUpperCase();
                return (
                  <Pill
                    key={account.id}
                    active={providerAccountRef === account.id}
                    onClick={() => setProviderAccountRef(account.id)}
                    small
                    title={status?.loggedIn ? `${account.label} authenticated` : `${account.label} not authenticated`}
                  >
                    {account.label.toUpperCase()} [{short}]
                  </Pill>
                );
              })}
            </Row>
          </Field>
        )}

        <Field label="MODEL" helpKey="review.model">
          {provider === 'cursor' && cursorCatalog?.models?.length ? (
            // Cursor: family × effort × flags (effort baked into the id) — ~150 ids
            // is too many for a pill row. Same picker as SpawnDialog / composer.
            <CursorModelSelect
              value={String(model)}
              onChange={(id) => setModel(id as ModelName)}
              selectStyle={cursorSelectStyle}
            />
          ) : (
            <Row>
              {modelsForProvider(provider, catalogs).map((m) => {
                const desc = provider === 'codex' ? codexCatalog?.models?.find((cm) => cm.id === m)?.description : undefined;
                return (
                  <Pill key={m} active={model === m} onClick={() => setModel(m)} small title={desc}>
                    {provider === 'claude' ? claudeModelLabel(String(m), claudeNativeCatalog) : String(m)}
                  </Pill>
                );
              })}
            </Row>
          )}
        </Field>

        {(() => {
          const honored = effortsForModel(provider, model, claudeNativeCatalog, codexCatalog);
          if (honored.length === 0) {
            const reason = provider === 'gemini' ? 'Gemini CLI has no effort flag.'
              : provider === 'antigravity' ? 'Effort is set inside the Antigravity desktop app.'
              : provider === 'cursor' ? 'Cursor bakes effort into the model id — set it in the MODEL picker above.'
              : 'Provider does not honor effort.';
            return (
              <Field label="EFFORT" helpKey="review.effort">
                <div className="display-font" style={{ padding: '6px 10px', border: '1px dashed var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '0.5px' }}>
                  {reason}
                </div>
              </Field>
            );
          }
          return (
            <Field label="EFFORT" helpKey="review.effort">
              <Row>
                {honored.map((e) => (
                  <Pill key={e} active={effort === e} onClick={() => setEffort(e)} small>
                    {e.toUpperCase()}
                  </Pill>
                ))}
              </Row>
            </Field>
          );
        })()}
        </>
        )}

        {isScopeLocked ? (
          <>
            <Field label="SCOPE" helpKey="review.scope">
              <div
                className="display-font"
                style={{
                  padding: '6px 10px',
                  border: '1px solid var(--color-accent-primary-dim)',
                  borderRadius: '3px',
                  color: 'var(--color-accent-primary)',
                  fontSize: '10px',
                  letterSpacing: '1px',
                  background: 'var(--color-accent-primary-a10)',
                }}
              >
                {prefilledScopeLabel ?? (isPlanReview ? 'PLAN' : 'HISTORY SLICE')}
              </div>
            </Field>
            {isPlanReview && (
            <Field label="MODE" helpKey="review.mode">
              <div
                className="display-font"
                style={{
                  padding: '6px 10px',
                  border: '1px solid var(--color-accent-primary-dim)',
                  borderRadius: '3px',
                  color: 'var(--color-accent-primary)',
                  fontSize: '10px',
                  letterSpacing: '1px',
                  background: 'var(--color-accent-primary-a10)',
                }}
              >
                {planMode === 'verify' ? 'VERIFY WORK' : 'CRITIQUE PLAN'}
              </div>
              <div
                className="display-font"
                style={{ marginTop: '4px', fontSize: '9px', color: 'var(--color-fg-muted)', letterSpacing: '0.5px', lineHeight: 1.5 }}
              >
                {planMode === 'verify'
                  ? 'Reviewer reads only the completed (`[x]`) items and checks each claim against the actual code in the tree.'
                  : 'Reviewer evaluates the plan itself — gaps, ordering, missing considerations. Not about whether work is done.'}
              </div>
            </Field>
            )}
            <Field label="OPTIONS">
              <label
                className="display-font"
                style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px', letterSpacing: '1px', color: 'var(--color-accent-primary-dim)', cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={includeGitDiff}
                  onChange={(e) => setIncludeGitDiff(e.target.checked)}
                />
                INCLUDE GIT DIFF
              </label>
              <div
                className="display-font"
                style={{ marginTop: '4px', fontSize: '9px', color: 'var(--color-fg-muted)', letterSpacing: '0.5px', lineHeight: 1.5 }}
              >
                {isPlanReview
                  ? 'Append `git diff HEAD` to the review body so the reviewer can see your in-progress changes alongside the plan items. The plan is still the primary subject — diff is supplementary.'
                  : 'Append `git diff HEAD` to the review body so the reviewer can see your in-progress changes alongside the transcript slice.'}
              </div>
            </Field>
          </>
        ) : (
        <Field label="SCOPE" helpKey="review.scope">
          <Row>
            {(Object.keys(SCOPE_LABELS) as ScopeKind[]).map((k) => (
              <Pill
                key={k}
                active={scopeKind === k}
                onClick={() => setScopeKind(k)}
                small
              >
                {SCOPE_LABELS[k]}
              </Pill>
            ))}
          </Row>
          <div
            className="display-font"
            style={{ marginTop: '4px', fontSize: '9px', color: 'var(--color-fg-muted)', letterSpacing: '0.5px' }}
          >
            {SCOPE_HINTS[scopeKind]}
          </div>
          {scopeKind === 'last-n' && (
            <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span
                className="display-font"
                style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)' }}
              >
                N =
              </span>
              <input
                type="number"
                min={1}
                max={50}
                value={lastN}
                onChange={(e) => setLastN(Number(e.target.value) || 1)}
                style={{
                  width: '60px',
                  padding: '4px 6px',
                  background: 'transparent',
                  border: '1px solid var(--color-border-hairline)',
                  borderRadius: '3px',
                  color: 'var(--color-accent-primary)',
                  fontFamily: 'var(--font-display)',
                  fontSize: '11px',
                }}
              />
            </div>
          )}
          <label
            className="display-font"
            style={{
              marginTop: '8px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '10px',
              letterSpacing: '1px',
              color: gitDiffCheckboxDisabled ? 'var(--color-fg-muted)' : 'var(--color-accent-primary-dim)',
              cursor: gitDiffCheckboxDisabled ? 'not-allowed' : 'pointer',
              opacity: gitDiffCheckboxDisabled ? 0.5 : 1,
            }}
          >
            <input
              type="checkbox"
              disabled={gitDiffCheckboxDisabled}
              checked={gitDiffCheckboxDisabled ? false : includeGitDiff}
              onChange={(e) => setIncludeGitDiff(e.target.checked)}
            />
            INCLUDE GIT DIFF
          </label>
        </Field>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
          <span data-help="review.cancel" style={{ display: 'inline-flex' }}>
            <Btn onClick={onCancel}>CANCEL</Btn>
          </span>
          <span data-help="review.run" style={{ display: 'inline-flex' }}>
            <Btn
              primary
              onClick={() => {
                const ref = buildContextRef();
                const diff = !isScopeLocked && scopeKind === 'git-diff' ? false : includeGitDiff;
                if (usingMember && onConfirmViaMember) {
                  onConfirmViaMember(reviewerKind, ref, diff);
                } else {
                  onConfirm({ provider, model, effort, ...(provider === 'codex' && providerAccountRef ? { providerAccountRef } : {}) }, ref, diff);
                }
              }}
            >
              {usingMember ? 'SEND REVIEW TASK' : 'RUN REVIEW'}
            </Btn>
          </span>
        </div>

        <div
          className="display-font"
          style={{ marginTop: '10px', fontSize: '9px', color: 'var(--color-fg-muted)', letterSpacing: '0.5px' }}
        >
          Read-only tools. Output lands in the Review tab as a markdown artifact.
        </div>
      </div>
    </div>
  );
}

function Field({ label, children, helpKey }: { label: string; children: React.ReactNode; helpKey?: string }) {
  return (
    <div data-help={helpKey} style={{ marginBottom: '10px' }}>
      <div
        className="display-font"
        style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '4px' }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>{children}</div>;
}

function Pill({
  active,
  onClick,
  disabled,
  children,
  small,
  title,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  small?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="display-font"
      style={{
        padding: small ? '4px 8px' : '6px 10px',
        background: active ? 'var(--color-accent-primary-a10)' : 'transparent',
        border: `1px solid ${active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
        borderRadius: '3px',
        color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: small ? '10px' : '11px',
        letterSpacing: '1px',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}

function Btn({
  onClick,
  children,
  primary,
}: { onClick: () => void; children: React.ReactNode; primary?: boolean }) {
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
