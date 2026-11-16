import { useEffect, useState, type CSSProperties } from 'react';
import { ROLE_PRESETS, presetForText, type ArcoSkillRef, type ClusterStatePayload, type ClusterSkillPin } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import { useStartupStore } from '../../stores/startupStore';
import { DialogShell } from '../DialogShell';

interface Skill { scope: 'project' | 'global'; slug: string; name: string; off?: boolean }
const button: CSSProperties = { padding: '3px 8px', background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-fg)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px' };
const roleLabel = (role: string) => presetForText(role)?.label ?? role;
const sameRef = (a: ArcoSkillRef, b: ArcoSkillRef) => a.scope === b.scope && a.slug === b.slug;

export function SkillsControl({ cluster, memberId }: { cluster: ClusterStatePayload; memberId?: string }) {
  const send = useAppStore(s => s.wsSendRaw);
  const connected = useAppStore(s => s.connected);
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<Skill[] | null>(null);
  const [error, setError] = useState('');
  const pins = cluster.skillPins ?? [];
  const role = cluster.members.find(member => member.workflowId === memberId)?.role;
  const applicable = pins.filter(pin => pin.role === undefined || pin.role === role);
  const count = memberId ? new Set(applicable.map(pin => `${pin.scope}:${pin.slug}`)).size : pins.length;
  const pinKey = JSON.stringify(pins);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCatalog(null); setError('');
    fetch(`/api/skills?cwd=${encodeURIComponent(cluster.cwd)}`).then(async response => {
      if (!response.ok) throw new Error('The skill list is unavailable. Close and open this window to try again.');
      return response.json();
    }).then(data => { if (!cancelled) setCatalog([...(data.project ?? []), ...(data.global ?? [])]); })
      .catch(reason => { if (!cancelled) setError(String(reason.message ?? reason)); });
    return () => { cancelled = true; };
  }, [open, cluster.cwd, pinKey]);
  if (memberId && count === 0) return null;
  return <>
    <button type="button" className="display-font" data-help="cluster.skills" style={button}
      aria-label={`${memberId ? 'Skills inherited from cluster' : 'Cluster skills'}, ${count} ${count === 1 ? 'pin' : 'pins'}`} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen(true)}>{memberId ? 'FROM CLUSTER' : 'SKILLS'} [{count}]</button>
    {open && <DialogShell title="Cluster skills" dataHelp="cluster.skills" onClose={() => setOpen(false)} closeOnBackdrop width={620}
      actions={<button type="button" style={button} data-help="cluster.skills" onClick={() => {
        setOpen(false); useStartupStore.getState().setSettingsSection('skills'); useAppStore.getState().setShowSettings(true);
      }}>SETTINGS &gt; SKILLS</button>}>
      <p>Full skill text is added to every turn for matching members, including new and replaced members. Only the operator changes these pins.</p>
      {!pins.length && <p>No skills are pinned to this cluster. Pin a skill from Settings &gt; SKILLS.</p>}
      {error && <p role="alert">{error}</p>}
      {pins.map((pin, index) => {
        const skill = catalog?.find(item => sameRef(item, pin));
        const status = catalog === null ? 'Loading' : !skill ? 'Missing or unreadable' : skill.off ? 'Off' : 'Available';
        return <div key={JSON.stringify([pin.scope, pin.slug, pin.role])} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', padding: '8px 0', borderBottom: '1px solid var(--color-border-hairline)' }}>
          <div style={{ flex: '1 1 180px', minWidth: 0, overflowWrap: 'anywhere' }}>
            <strong>{skill?.name ?? pin.slug}</strong> <span style={{ color: 'var(--color-fg-muted)' }}>({pin.scope})</span>
            <div>{pin.role === undefined ? 'All members' : `Role: ${roleLabel(pin.role)}`}</div>
            <div style={{ color: 'var(--color-fg-muted)' }}>{status}</div>
          </div>
          <button type="button" data-help="cluster.skills.unpin" style={button} disabled={!connected}
            aria-label={`Unpin ${skill?.name ?? pin.slug} from ${pin.role === undefined ? 'all members' : roleLabel(pin.role)}`}
            onClick={() => send?.({ type: 'cluster_skills_set', clusterId: cluster.clusterId, pins: pins.filter((_pin, n) => n !== index) })}>UNPIN</button>
        </div>;
      })}
      <p>Tab pins, cluster pins and matching role pins share one limit: 12 unique skills and 64 KiB of text. Missing or off skills are skipped. A skill that grows beyond the limit is reported in the conversation.</p>
    </DialogShell>}
  </>;
}

export function PinSkillDialog({ skill, cwd, kind, onClose }: { skill: Skill; cwd: string; kind: 'tab' | 'cluster'; onClose: () => void }) {
  const clusters = useAppStore(s => s.clusters);
  const jobs = useAppStore(s => s.jobs);
  const send = useAppStore(s => s.wsSendRaw);
  const connected = useAppStore(s => s.connected);
  const targets = kind === 'cluster'
    ? Object.values(clusters).filter(cluster => skill.scope === 'global' || cluster.cwd === cwd).map(cluster => ({ id: cluster.clusterId, name: cluster.name ?? `Cluster ${cluster.clusterId.slice(0, 8)}` }))
    : Object.values(jobs).filter(job => job.config.kind !== 'chat' && (skill.scope === 'global' || job.config.workingDirectory === cwd)).map(job => ({ id: job.id, name: job.config.name || job.id.slice(0, 8) }));
  const [target, setTarget] = useState(targets[0]?.id ?? '');
  const [scope, setScope] = useState('all');
  const [customRole, setCustomRole] = useState('');
  const cluster = kind === 'cluster' ? clusters[target] : undefined;
  const roles = [...new Set([...(cluster?.members.flatMap(member => member.role ? [member.role] : []) ?? []), ...ROLE_PRESETS.map(preset => preset.text)])];
  const role = scope === 'all' ? undefined : scope === 'custom' ? customRole.trim() : scope.slice(5);
  const valid = targets.some(item => item.id === target) && (scope === 'all' || !!role) && connected;
  const members = cluster?.members.filter(member => role === undefined || member.role === role).length ?? 1;
  const pin = () => {
    if (!valid) return;
    if (cluster) {
      const next: ClusterSkillPin = { scope: skill.scope, slug: skill.slug, ...(role !== undefined ? { role } : {}) };
      const pins = cluster.skillPins ?? [];
      if (!pins.some(existing => sameRef(existing, next) && existing.role === next.role)) send?.({ type: 'cluster_skills_set', clusterId: target, pins: [...pins, next] });
    } else {
      const existing = jobs[target]?.config.pinnedSkills ?? [];
      if (!existing.some(ref => sameRef(ref, skill))) send?.({ type: 'update_primary_config', workflowId: target, pinnedSkills: [...existing, { scope: skill.scope, slug: skill.slug }] });
    }
    onClose();
  };
  return <DialogShell title={`Pin ${skill.name} to ${kind}`} dataHelp="settings.skills.pin" onClose={onClose} width={620}
    actions={<><button type="button" data-help="settings.skills.pin" style={button} onClick={onClose}>CANCEL</button><button type="button" data-help="settings.skills.pin" style={button} disabled={!valid} onClick={pin}>PIN</button></>}>
    {!targets.length ? <p>Open {kind === 'cluster' ? 'a cluster' : 'an Agent tab'}{skill.scope === 'project' ? ' for this project' : ''} to pin this skill.</p> : <>
      <label>{kind === 'cluster' ? 'Cluster' : 'Tab'}<select className="arco-field" aria-label={`Pin destination ${kind}`} data-help="settings.skills.pin" value={target} style={{ display: 'block', width: '100%', minWidth: 0 }} onChange={event => { setTarget(event.target.value); setScope('all'); }}>
        {targets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      {cluster && <label>Apply to<select className="arco-field" aria-label="Cluster skill scope" data-help="settings.skills.pin" value={scope} style={{ display: 'block', width: '100%', minWidth: 0 }} onChange={event => setScope(event.target.value)}>
        <option value="all">All members</option>{roles.map(saved => <option key={saved} value={`role:${saved}`}>Role: {roleLabel(saved)}</option>)}<option value="custom">Other role</option>
      </select></label>}
      {scope === 'custom' && <label>Exact saved role text<input className="arco-field" aria-label="Exact saved role text" data-help="settings.skills.pin" value={customRole} maxLength={120} onChange={event => setCustomRole(event.target.value)} style={{ display: 'block', width: '100%' }} /></label>}
      <p>{cluster ? `Added to every turn for ${members} current ${members === 1 ? 'member' : 'members'}; new and replaced matching members inherit it.` : 'Added to every turn in this tab.'} The combined limit is 12 unique skills and 64 KiB with existing tab and cluster pins.</p>
      {skill.scope === 'project' && <p>Pinning applies this project's skill text even when project trust is off. Review the skill before pinning it.</p>}
    </>}
  </DialogShell>;
}
