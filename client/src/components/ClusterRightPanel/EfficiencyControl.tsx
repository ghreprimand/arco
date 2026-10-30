// 2026-06-15 — per-cluster efficiency selector. Lives in the ClusterRightPanel
// header chip bar next to MAIL ALERTS / AUTO-PICKUP. One operator-set knob with
// three levels (thorough / balanced / lean) that dials how thorough vs. lean
// the whole cluster behaves: chunk size, cross-review restraint, peer-message
// chattiness. The server (clusterEfficiency.ts) owns the deterministic bundle;
// this just picks the level + optional doctrine addendum and ships it via
// cluster_efficiency_set. The new level takes effect on each member's NEXT
// turn.

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
  onSetEfficiency,
}: {
  clusterId: string;
  level: ClusterEfficiencyLevel;
  addendum?: string;
  onSetEfficiency: (clusterId: string, level: ClusterEfficiencyLevel, addendum?: string) => void;
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
          title={addendum ? `Doctrine note: ${addendum}` : 'Add a cluster-specific doctrine note'}
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
          placeholder="Cluster-specific doctrine note (appended to the canned text)…"
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
    </>
  );
}
