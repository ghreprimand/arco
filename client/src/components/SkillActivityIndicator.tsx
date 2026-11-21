import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore, type JobState } from '../stores/appStore';

type MemberActivity = {
  id: string;
  label: string;
  skills: NonNullable<JobState['skillActivity']>;
};

// A cluster displays one conversation. Its member cards do not own skill strips.
export function SkillActivityIndicator({ workflowId, clusterId }: { workflowId: string; clusterId?: string }) {
  const jobs = useAppStore(s => s.jobs);
  const cluster = useAppStore(s => clusterId ? s.clusters[clusterId] : undefined);
  const members = cluster?.members ?? [{ workflowId, displayName: jobs[workflowId]?.config.name ?? 'This conversation' }];
  const entries: MemberActivity[] = [];
  for (const member of members) {
    const job = jobs[member.workflowId];
    if (job?.busy && job.skillActivity?.length) {
      entries.push({ id: member.workflowId, label: member.displayName, skills: job.skillActivity });
    }
  }
  if (!entries.length) return null;
  return <SkillDisclosure key={workflowId} selected={entries.find(entry => entry.id === workflowId)} entries={entries} />;
}

function SkillDisclosure({ selected, entries }: { selected?: MemberActivity; entries: MemberActivity[] }) {
  const regionId = useId();
  const control = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLButtonElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [fits, setFits] = useState(true);
  const name = selected?.skills.length === 1 ? selected.skills[0].name : undefined;
  const others = entries.filter(entry => entry !== selected);
  const memberCount = `${others.length} ${others.length === 1 ? 'member' : 'members'}`;

  useLayoutEffect(() => {
    const label = measure.current;
    if (!label || !name) return;
    const update = () => setFits(label.scrollWidth <= label.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(label);
    return () => observer.disconnect();
  }, [name]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: MouseEvent) => {
      if (!control.current?.contains(event.target as Node)) {
        setOpen(false);
        // Keep a deliberately focused outside control, such as the composer.
        if (document.activeElement === document.body || control.current?.contains(document.activeElement)) {
          summary.current?.focus({ preventScroll: true });
        }
      }
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      summary.current?.focus({ preventScroll: true });
    };
    document.addEventListener('click', dismissOutside, true);
    document.addEventListener('keydown', dismissEscape, true);
    return () => {
      document.removeEventListener('click', dismissOutside, true);
      document.removeEventListener('keydown', dismissEscape, true);
    };
  }, [open]);

  const text = !selected ? `Skills · ${memberCount}`
    : name && fits ? `Skill · ${name}` : `Skills · ${selected.skills.length}`;
  return <div ref={control} data-help="skills.activity" style={{ display: 'flex', flexDirection: 'column', minWidth: 0, maxHeight: 'min(100%, max(112px, 50%))', fontSize: '11px' }}>
    <button type="button" ref={summary} aria-controls={regionId} aria-expanded={open} onClick={() => setOpen(value => !value)}
      style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: '6px', minHeight: '28px', padding: '4px 12px', textAlign: 'left', color: 'var(--color-fg-muted)', background: 'transparent', border: 0, font: 'inherit', cursor: 'pointer' }}>
      <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      <span style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        {name && <span ref={measure} aria-hidden="true" style={{ position: 'absolute', inset: 0, visibility: 'hidden', overflow: 'hidden', whiteSpace: 'nowrap' }}>Skill · {name}</span>}
        {text}
      </span>
      {selected && others.length > 0 && <span>+{memberCount}</span>}
    </button>
    <div id={regionId} role="region" aria-label="Skill activity details" hidden={!open} tabIndex={0}
      style={{ overflowY: 'auto', overflowWrap: 'anywhere', padding: '4px 12px 8px', color: 'var(--color-fg)', background: 'var(--color-bg-panel)', borderBottom: '1px solid var(--color-border-hairline)' }}>
      {(selected ? [selected, ...others] : others).map(entry => <div key={entry.id}>
        <strong>{entry.label}</strong>
        {entry.skills.map(skill => <div key={`${skill.scope}:${skill.name}`}>{skill.kind === 'applied' ? 'Applied' : 'Loaded'}: {skill.name}</div>)}
      </div>)}
    </div>
  </div>;
}
