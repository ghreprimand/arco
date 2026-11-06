import type { CSSProperties } from 'react';
import { MEMBER_TIERS, OUTPUT_STYLES, type ClusterMemberProvider } from '@arco/shared';
import { AutoCompactionThreshold } from '../AutoCompactionThreshold';
import { memberSettingsShown, type MemberSettings } from './memberSettings';

// WORK SIZE, FOCUS, FAST MODE, TOOL FILTER, OUTPUT STYLE and AUTO-COMPACTION
// for a new member, shared by ADD FRESH and REPLACE. `testId` prefixes the
// test ids so a browser test can tell the two dialogs apart.
const labelStyle: CSSProperties = { color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '1px', minWidth: '84px' };
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' };

function pill(active: boolean): CSSProperties {
  return {
    padding: '3px 8px',
    background: active ? 'var(--color-accent-primary-a10)' : 'transparent',
    border: `1px solid ${active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
    color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
    cursor: 'pointer',
    fontSize: '10px',
    letterSpacing: '1px',
  };
}

export function MemberSettingsFields({ value, onChange, provider, clusterDefault, testId }: {
  value: MemberSettings;
  onChange: (next: MemberSettings) => void;
  provider: ClusterMemberProvider;
  // The cluster's auto-compaction, described next to CLUSTER DEFAULT.
  clusterDefault?: { enabled: boolean; thresholdPercent: number } | null;
  testId: string;
}) {
  const shown = memberSettingsShown(provider);
  const set = (patch: Partial<MemberSettings>) => onChange({ ...value, ...patch });
  const own = value.autoCompaction;
  return (
    <div data-testid={`${testId}-settings`} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={rowStyle}>
        <span data-help="cluster.member.tier" className="display-font" style={labelStyle}>WORK SIZE</span>
        {([...MEMBER_TIERS, ''] as const).map((t) => (
          <button key={t || 'unset'} type="button" data-help="cluster.member.tier" data-testid={`${testId}-tier-${t || 'unset'}`}
            className="display-font" onClick={() => set({ tier: t })} style={pill(value.tier === t)}>
            {t ? t.toUpperCase() : 'UNSET'}
          </button>
        ))}
      </div>
      <div style={rowStyle}>
        <span data-help="cluster.member.focus" className="display-font" style={labelStyle}>FOCUS</span>
        <input type="text" maxLength={160} placeholder="optional" aria-label="Member focus" data-help="cluster.member.focus" data-testid={`${testId}-focus`}
          value={value.focus} onChange={(e) => set({ focus: e.target.value })}
          style={{ flex: 1, minWidth: '120px', background: 'var(--color-bg)', color: 'var(--color-fg)', border: '1px solid var(--color-border-hairline)', padding: '4px 6px', fontSize: '11px', fontFamily: 'var(--font-code)' }} />
      </div>
      {shown.fastMode && (
        <div style={rowStyle}>
          <span data-help="cluster.member.fast-mode" className="display-font" style={labelStyle}>FAST MODE</span>
          {[false, true].map((on) => (
            <button key={String(on)} type="button" data-help="cluster.member.fast-mode" data-testid={`${testId}-fast-${on ? 'on' : 'off'}`}
              className="display-font" onClick={() => set({ fastMode: on })} style={pill(value.fastMode === on)}>
              {on ? 'ON' : 'OFF'}
            </button>
          ))}
        </div>
      )}
      {shown.toolFilter && (
        <div style={rowStyle}>
          <span data-help="cluster.member.tool-filter" className="display-font" style={labelStyle}>TOOL FILTER</span>
          {(['off', 'conservative', 'aggressive'] as const).map((opt) => (
            <button key={opt} type="button" data-help="cluster.member.tool-filter" data-testid={`${testId}-filter-${opt}`}
              className="display-font" onClick={() => set({ efficiencyToolFilter: opt })} style={pill(value.efficiencyToolFilter === opt)}>
              {opt.toUpperCase()}
            </button>
          ))}
        </div>
      )}
      {shown.outputStyle && (
        <div style={rowStyle}>
          <span data-help="cluster.member.output-style" className="display-font" style={labelStyle}>OUTPUT STYLE</span>
          {OUTPUT_STYLES.map((opt) => (
            <button key={opt} type="button" data-help="cluster.member.output-style" data-testid={`${testId}-style-${opt}`}
              className="display-font" onClick={() => set({ outputStyle: opt })} style={pill(value.outputStyle === opt)}>
              {opt.toUpperCase()}
            </button>
          ))}
        </div>
      )}
      <div style={rowStyle}>
        <span data-help="cluster.member.auto-compaction" className="display-font" style={labelStyle}>AUTO-COMPACT</span>
        <select aria-label="Member auto-compaction" data-help="cluster.member.auto-compaction" data-testid={`${testId}-compaction`}
          className="display-font"
          value={own ? own.enabled ? 'on' : 'off' : 'cluster'}
          onChange={(e) => set({ autoCompaction: e.target.value === 'cluster' ? null : { enabled: e.target.value === 'on', thresholdPercent: own?.thresholdPercent ?? clusterDefault?.thresholdPercent ?? 80 } })}
          style={{ background: 'var(--color-bg)', color: 'var(--color-fg)', border: '1px solid var(--color-border-hairline)', padding: '3px 6px', fontSize: '10px', fontFamily: 'var(--font-code)' }}>
          <option value="cluster">CLUSTER DEFAULT{clusterDefault ? ` (${clusterDefault.enabled ? `ON ${clusterDefault.thresholdPercent}%` : 'OFF'})` : ''}</option>
          <option value="off">OFF</option>
          <option value="on">ON</option>
        </select>
        {own?.enabled && (
          <span data-help="cluster.member.auto-compaction" style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>
            <AutoCompactionThreshold label="Member auto-compaction threshold percent" value={own.thresholdPercent} onCommit={(thresholdPercent) => set({ autoCompaction: { ...own, thresholdPercent } })} />
          </span>
        )}
      </div>
    </div>
  );
}
