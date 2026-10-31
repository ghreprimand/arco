import { useState } from 'react';
import type { ClusterMemberProvider, EffortLevel, MemberTier, ModelName } from '@arco/shared';
import { CLUSTER_TEMPLATES, ROLE_GUIDANCE, roleLabel, roleText, type ClusterTemplate } from './clusterTemplates';
import { MEMBER_PROVIDER_NAMES } from './memberProviders';

export interface TemplateMemberChoice {
  role: string;
  tier: MemberTier;
  provider: ClusterMemberProvider;
  model: ModelName;
  effort: EffortLevel;
}

interface Choice { provider: ClusterMemberProvider | ''; model: string; effort: EffortLevel; explicitEffort: boolean }

interface Props {
  providers: ClusterMemberProvider[];
  modelsFor: (provider: ClusterMemberProvider) => { value: ModelName; label: string; subline?: string }[];
  effortsFor: (provider: ClusterMemberProvider, model: ModelName) => EffortLevel[];
  capEffort: (effort: EffortLevel, provider: ClusterMemberProvider, model: ModelName) => EffortLevel;
  isLocal: (provider: ClusterMemberProvider) => boolean;
  onApply: (members: TemplateMemberChoice[], template: ClusterTemplate) => void;
  onOpenConnections: () => void;
  selectStyle: (selected: boolean) => React.CSSProperties;
  labelStyle: React.CSSProperties;
  hintStyle: React.CSSProperties;
}

const linkStyle: React.CSSProperties = { background: 'none', border: 'none', padding: 0, color: 'var(--color-accent-secondary)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' };

// Built-in starting shapes for a cluster, with a review step. Choosing a
// template never picks a model: each member shows its role, the recommended
// model tier and effort in words, and the operator chooses provider and model
// from connected providers. Nothing changes until "Use these members".
export function ClusterTemplatePicker({ providers, modelsFor, effortsFor, capEffort, isLocal, onApply, onOpenConnections, selectStyle, labelStyle, hintStyle }: Props) {
  const [template, setTemplate] = useState<ClusterTemplate | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [applied, setApplied] = useState<string | null>(null);

  const start = (t: ClusterTemplate) => {
    setTemplate(t);
    setApplied(null);
    // One connected provider is the only possible answer, so it is filled in.
    const only = providers.length === 1 ? providers[0]! : '';
    setChoices(t.roles.map((r) => ({ provider: only, model: '', effort: ROLE_GUIDANCE[r].effort, explicitEffort: false })));
  };
  const update = (i: number, patch: Partial<Choice>) => setChoices((prev) => prev.map((c, j) => {
    if (j !== i) return c;
    const next = { ...c, ...patch };
    if (patch.provider !== undefined && patch.provider !== c.provider) next.model = '';
    if (next.provider && next.model && !next.explicitEffort) {
      next.effort = capEffort(ROLE_GUIDANCE[template!.roles[i]!].effort, next.provider, next.model as ModelName);
    }
    return next;
  }));

  const labels = template ? template.roles.map((r, i, all) => {
    const same = all.filter((x) => x === r).length;
    return same > 1 ? `${roleLabel(r)} ${all.slice(0, i + 1).filter((x) => x === r).length}` : roleLabel(r);
  }) : [];
  const ready = choices.length > 0 && choices.every((c) => c.provider && c.model);
  const localCount = choices.filter((c) => c.provider && isLocal(c.provider)).length;

  return (
    <div data-help="creator.cluster-templates" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <label className="display-font" style={{ ...labelStyle, marginBottom: 0 }}>START FROM A TEMPLATE</label>
      <div role="group" aria-label="Cluster templates" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {CLUSTER_TEMPLATES.map((t) => (
          <button key={t.id} type="button" aria-pressed={template?.id === t.id} title={t.summary} onClick={() => start(t)} className="display-font" style={{ ...selectStyle(template?.id === t.id), padding: '6px 12px', fontSize: '10px' }}>
            {t.name.toUpperCase()}
          </button>
        ))}
        <button type="button" aria-pressed={template === null} onClick={() => { setTemplate(null); setChoices([]); }} className="display-font" style={{ ...selectStyle(template === null), padding: '6px 12px', fontSize: '10px' }}>
          BUILD MY OWN
        </button>
      </div>
      {!template && <div role="status" style={{ ...hintStyle, fontSize: '10px', lineHeight: 1.5, overflowWrap: 'anywhere' }}>{applied ? `${applied} members are in the list below. Review each member, then create the cluster.` : 'Pick a shape to review its members, or set up the members below yourself.'}</div>}

      {template && (
        <section aria-label={`Review ${template.name} template`} style={{ border: '1px solid var(--color-accent-secondary-dim)', borderRadius: '6px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div>
            <div className="display-font" style={{ color: 'var(--color-accent-primary)', fontSize: '12px', letterSpacing: '2px' }}>REVIEW: {template.name.toUpperCase()}</div>
            <p style={{ ...hintStyle, fontSize: '11px', lineHeight: 1.5, marginTop: '6px', overflowWrap: 'anywhere' }}>
              {template.summary} Choose a provider and model for each member from your connected providers; Arco does not choose models for you. The current members are replaced only when you select Use these members.
            </p>
          </div>
          {providers.length === 0 && (
            <div role="alert" style={{ ...hintStyle, fontSize: '11px', color: 'var(--color-warning)', overflowWrap: 'anywhere' }}>
              No cluster-capable provider is connected and enabled.{' '}
              <button type="button" onClick={onOpenConnections} style={linkStyle}>Open Connections</button>
            </div>
          )}
          {template.roles.map((role, i) => {
            const guide = ROLE_GUIDANCE[role];
            const c = choices[i]!;
            const models = c.provider ? modelsFor(c.provider) : [];
            const efforts = c.provider && c.model ? effortsFor(c.provider, c.model as ModelName) : [];
            const name = labels[i]!;
            return (
              <div key={i} data-template-member={name} style={{ borderTop: i ? '1px solid var(--color-border-hairline)' : 'none', paddingTop: i ? '10px' : 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div className="display-font" style={{ fontSize: '11px', letterSpacing: '1px', color: 'var(--color-accent-primary)' }}>{name}</div>
                <div style={{ fontSize: '11px', lineHeight: 1.5, color: 'var(--color-fg-primary)', overflowWrap: 'anywhere' }}>
                  <strong>Recommended:</strong> {guide.advice} {guide.reason}
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                  <select className="arco-field" aria-label={`Provider for ${name}`} value={c.provider} onChange={(e) => update(i, { provider: e.target.value as ClusterMemberProvider })}>
                    {providers.length !== 1 && <option value="">Choose a provider</option>}
                    {providers.map((p) => <option key={p} value={p}>{MEMBER_PROVIDER_NAMES[p]}</option>)}
                  </select>
                  <select className="arco-field" aria-label={`Model for ${name}`} value={c.model} disabled={!c.provider} onChange={(e) => update(i, { model: e.target.value })} style={{ minWidth: 0, maxWidth: '100%' }}>
                    <option value="">{c.provider && models.length === 0 ? 'No models available' : 'Choose a model'}</option>
                    {models.map((m) => <option key={String(m.value)} value={String(m.value)}>{m.label}{m.subline ? ` - ${m.subline}` : ''}</option>)}
                  </select>
                </div>
                {efforts.length > 0 && (
                  <div role="group" aria-label={`Effort for ${name}`} style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {efforts.map((e) => (
                      <button key={e} type="button" aria-pressed={c.effort === e} onClick={() => update(i, { effort: e, explicitEffort: true })} style={{ ...selectStyle(c.effort === e), padding: '4px 10px', fontSize: '10px' }}>{e.toUpperCase()}</button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {localCount > 1 && <div role="status" style={{ ...hintStyle, fontSize: '11px', color: 'var(--color-warning)', overflowWrap: 'anywhere' }}>Use at most one local member; local turns are serialized on this machine.</div>}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button type="button" disabled={!ready} onClick={() => { onApply(template.roles.map((r, i) => ({ role: roleText(r), tier: ROLE_GUIDANCE[r].tier, provider: choices[i]!.provider as ClusterMemberProvider, model: choices[i]!.model as ModelName, effort: choices[i]!.effort })), template); setApplied(template.name); setTemplate(null); setChoices([]); }} className="display-font" style={{ ...selectStyle(ready), padding: '6px 14px', opacity: ready ? 1 : 0.6, cursor: ready ? 'pointer' : 'not-allowed' }}>
              USE THESE MEMBERS
            </button>
            <button type="button" onClick={() => { setTemplate(null); setChoices([]); }} className="display-font" style={{ ...selectStyle(false), padding: '6px 14px' }}>CANCEL</button>
          </div>
          {!ready && <div style={{ ...hintStyle, fontSize: '10px' }}>Choose a provider and model for every member to continue.</div>}
        </section>
      )}
    </div>
  );
}
