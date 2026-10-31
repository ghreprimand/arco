import { MessageGuardControl } from './MessageGuardControl';
import { resolveClusterMessageGuard, type ClusterMessageGuard } from '@arco/shared';
// Style, appended NOTE and independent message guard in the existing control bar.

import { useEffect, useState } from 'react';
import {
  CLUSTER_EFFICIENCY_LEVELS,
  CLUSTER_EFFICIENCY_LABELS,
  CLUSTER_EFFICIENCY_ADDENDUM_MAX,
  type ClusterEfficiencyLevel,
} from '@arco/shared';

export function EfficiencyControl({
  clusterId,
  level,
  addendum,
  messageGuard,
  onSetEfficiency,
}: {
  clusterId: string;
  level: ClusterEfficiencyLevel;
  addendum?: string;
  messageGuard?: ClusterMessageGuard;
  onSetEfficiency: (clusterId: string, level: ClusterEfficiencyLevel, addendum?: string, messageGuard?: ClusterMessageGuard) => void;
}) {
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(addendum ?? '');
  // Keep the draft in sync when the server echoes a new addendum (e.g. another
  // observer edited it). Only while not actively editing so we don't clobber
  // the operator's in-progress text.
  useEffect(() => {
    if (!editingNote) setNoteDraft(addendum ?? '');
  }, [addendum, editingNote]);

  const commitNote = () => {
    setEditingNote(false);
    const next = noteDraft.trim();
    if (next === (addendum ?? '').trim()) return; // no change
    onSetEfficiency(clusterId, level, next);
  };

  return (
    <>
      <span
        className="display-font"
        style={{ color: 'var(--color-fg-muted)', letterSpacing: '1px', marginLeft: '10px' }}
      >
        EFFICIENCY
      </span>
      <div data-help="cluster.efficiency" style={{ display: 'flex', gap: '3px' }}>
        {CLUSTER_EFFICIENCY_LEVELS.map((lvl) => {
          const active = lvl === level;
          return (
            <button
              key={lvl}
              aria-pressed={active}
              onClick={() => onSetEfficiency(clusterId, lvl)}
              className="display-font"
              title={CLUSTER_EFFICIENCY_LABELS[lvl].blurb}
              style={{
                padding: '3px 8px',
                background: active ? 'var(--color-accent-primary-a06)' : 'transparent',
                border: '1px solid ' + (active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
                color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                cursor: 'pointer',
                fontSize: '9px',
                letterSpacing: '1px',
              }}
            >
              {CLUSTER_EFFICIENCY_LABELS[lvl].label.toUpperCase()}
            </button>
          );
        })}
        {/* Optional doctrine addendum — operator free-text appended to the
            canned doctrine. Pencil toggles an inline input; commit on blur /
            Enter, cancel on Escape. */}
        <button
          onClick={() => setEditingNote((v) => !v)}
          className="display-font"
          title={addendum ? `Coordination note: ${addendum}` : 'Optional note added to this cluster\'s coordination instructions'}
          style={{
            padding: '3px 6px',
            background: addendum ? 'var(--color-accent-primary-a06)' : 'transparent',
            border: '1px solid ' + (addendum ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
            color: addendum ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
            cursor: 'pointer',
            fontSize: '9px',
            letterSpacing: '1px',
          }}
        >
          {addendum ? 'NOTE•' : 'NOTE'}
        </button>
      </div>
      {editingNote && (
        <input
          autoFocus
          value={noteDraft}
          maxLength={CLUSTER_EFFICIENCY_ADDENDUM_MAX}
          placeholder="Optional note added to this cluster's coordination instructions"
          onChange={(e) => setNoteDraft(e.target.value)}
          onBlur={commitNote}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitNote();
            else if (e.key === 'Escape') {
              setNoteDraft(addendum ?? '');
              setEditingNote(false);
            }
          }}
          style={{
            flex: 1,
            minWidth: '160px',
            marginLeft: '6px',
            padding: '3px 6px',
            background: 'var(--color-bg-input)',
            border: '1px solid var(--color-border-hairline)',
            color: 'var(--color-fg-default)',
            fontSize: '10px',
          }}
        />
      )}
      <MessageGuardControl value={resolveClusterMessageGuard({ efficiencyLevel: level, messageGuard })} onChange={guard => onSetEfficiency(clusterId, level, undefined, guard)} />
    </>
  );
}
