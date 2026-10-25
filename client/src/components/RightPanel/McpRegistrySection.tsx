import { useEffect, useMemo, useState } from 'react';
import type { ProviderName } from '@arco/shared';
import { useAppStore, type JobState } from '../../stores/appStore';

// ARCO_OPS_PLAN.md §E1 — MCP registry management surface in the CONFIG tab.
//
// Two layers, both operator-driven:
//   - REGISTER (global): CRUD over machine-wide MCP server defs. Add a server
//     by command + args + optional env; enable/disable the master switch;
//     remove. The registry is global so every tab sees the same list.
//   - PER-TAB: for each globally-enabled server, a per-tab enable toggle. When
//     enabled, every NON-dangerous tool is exposed; dangerous tools (flagged
//     from a name denylist) stay OFF until the operator ticks them per tab.
//     The full tool list is always shown for transparency (run a probe to
//     populate it + run connection diagnostics).
//
// Enforcement reality (LOCKED decisions): on CLI Claude the dangerous-tool
// denylist is REAL (unticked dangerous tools become --disallowedTools, which
// removes them from the model's set). On Codex there is NO per-tool gate, so
// enabling a server exposes ALL its tools — surfaced here as a warning.
export interface McpSenders {
  list: (workflowId?: string) => void;
  create: (input: { name: string; command: string; args: string[]; env?: Record<string, string>; enabled?: boolean; overrideMalwareWarning?: boolean }) => void;
  update: (input: { id: string; name?: string; command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }) => void;
  remove: (id: string) => void;
  allow: (workflowId: string, serverId: string, enabled: boolean, allowedDangerousTools: string[], disabledTools?: string[]) => void;
  probe: (serverId: string, workflowId?: string) => void;
}

export function McpRegistrySection({ job, mcp }: { job: JobState; mcp: McpSenders }) {
  const provider: ProviderName = job.config.primaryProvider ?? 'claude';
  const registry = useAppStore((s) => s.mcpRegistry);
  const allowByWf = useAppStore((s) => s.mcpAllow);
  const probeResults = useAppStore((s) => s.mcpProbeResults);
  const malwareWarning = useAppStore((s) => s.mcpMalwareWarning);
  const setMalwareWarning = useAppStore((s) => s.setMcpMalwareWarning);
  const allow = allowByWf[job.id] ?? [];

  // Pull the global registry + this tab's allowlist when the section mounts.
  useEffect(() => {
    mcp.list(job.id);
  }, [job.id, mcp]);

  const codexGap = provider === 'codex';

  return (
    <div style={{ marginTop: '18px' }} data-help="rightpanel.config.mcp">
      <div
        className="display-font"
        style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}
      >
        MCP SERVERS
      </div>

      {codexGap && (
        <div
          style={{
            fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)',
            lineHeight: 1.5, marginBottom: '8px', border: '1px solid var(--color-border-hairline)',
            borderRadius: '2px', padding: '6px 8px',
          }}
        >
          Codex exposes <strong>all</strong> tools of an enabled server — it has no per-tool deny
          flag, so the dangerous-tool denylist is not enforced here. Enable only servers you trust
          fully on a Codex tab.
        </div>
      )}

      {registry.length === 0 && (
        <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', marginBottom: '8px' }}>
          No MCP servers registered. Add one below.
        </div>
      )}

      {registry.map((srv) => {
        const a = allow.find((x) => x.serverId === srv.id);
        const probe = probeResults[srv.id];
        return (
          <ServerRow
            key={srv.id}
            srv={srv}
            enabledForTab={a?.enabled ?? false}
            ticked={a?.allowedDangerousTools ?? []}
            disabled={a?.disabledTools ?? []}
            cachedTools={a?.tools ?? []}
            probe={probe}
            codexGap={codexGap}
            onToggleGlobal={(enabled) => mcp.update({ id: srv.id, enabled })}
            onRemove={() => mcp.remove(srv.id)}
            onToggleTab={(enabled) => mcp.allow(job.id, srv.id, enabled, a?.allowedDangerousTools ?? [], a?.disabledTools ?? [])}
            onProbe={() => mcp.probe(srv.id, job.id)}
            onTickDangerous={(toolName, ticked) => {
              const cur = new Set(a?.allowedDangerousTools ?? []);
              if (ticked) cur.add(toolName); else cur.delete(toolName);
              mcp.allow(job.id, srv.id, a?.enabled ?? true, [...cur], a?.disabledTools ?? []);
            }}
            onToggleDisabled={(toolName, isDisabled) => {
              // DD11b — toggle the per-tab disable-list (independent of the
              // dangerous tick). Preserve the dangerous-tick set unchanged.
              const cur = new Set(a?.disabledTools ?? []);
              if (isDisabled) cur.add(toolName); else cur.delete(toolName);
              mcp.allow(job.id, srv.id, a?.enabled ?? true, a?.allowedDangerousTools ?? [], [...cur]);
            }}
          />
        );
      })}

      <AddServerForm onCreate={(input) => mcp.create(input)} />

      {/* H21 — OSV malware pre-check tripped. Block-with-override: the add was
          NOT applied; the operator must explicitly proceed. */}
      {malwareWarning && (
        <div
          style={{
            marginTop: '10px', padding: '10px 12px', borderRadius: '3px',
            border: '1px solid var(--color-warning)', background: 'var(--color-warning-a12, transparent)',
          }}
        >
          <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-warning)', marginBottom: '6px' }}>
            ⚠ MALWARE ADVISORY — ADD BLOCKED
          </div>
          <div style={{ fontSize: '11px', color: 'var(--color-fg)', fontFamily: 'var(--font-body)', lineHeight: 1.5, marginBottom: '8px' }}>
            OSV flagged the following package(s) referenced by <code>{malwareWarning.pending.command}</code> as known-malicious:
            <ul style={{ margin: '6px 0', paddingLeft: '18px' }}>
              {malwareWarning.packages.map((p) => (
                <li key={p.name}>
                  <strong>{p.name}</strong> ({p.ecosystem}) — {p.ids.join(', ')}
                </li>
              ))}
            </ul>
            Only proceed if you are certain this is a false positive.
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => { mcp.create(malwareWarning.pending); setMalwareWarning(null); }}
              className="display-font"
              style={{ padding: '4px 12px', background: 'transparent', border: '1px solid var(--color-warning)', borderRadius: '3px', color: 'var(--color-warning)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px' }}
            >
              PROCEED ANYWAY
            </button>
            <button
              onClick={() => setMalwareWarning(null)}
              className="display-font"
              style={{ padding: '4px 12px', background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px' }}
            >
              CANCEL
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ServerRow({
  srv, enabledForTab, ticked, disabled, cachedTools, probe, codexGap,
  onToggleGlobal, onRemove, onToggleTab, onProbe, onTickDangerous, onToggleDisabled,
}: {
  srv: ReturnType<typeof useAppStore.getState>['mcpRegistry'][number];
  enabledForTab: boolean;
  ticked: string[];
  disabled: string[];
  cachedTools: { name: string; description?: string; dangerous: boolean }[];
  probe: ReturnType<typeof useAppStore.getState>['mcpProbeResults'][string] | undefined;
  codexGap: boolean;
  onToggleGlobal: (enabled: boolean) => void;
  onRemove: () => void;
  onToggleTab: (enabled: boolean) => void;
  onProbe: () => void;
  onTickDangerous: (toolName: string, ticked: boolean) => void;
  onToggleDisabled: (toolName: string, disabled: boolean) => void;
}) {
  // Prefer the live probe result for the visible tool list; fall back to the
  // cached list persisted in the allowlist (so the list survives reloads).
  const tools = probe?.tools && probe.tools.length > 0 ? probe.tools : cachedTools;
  const tickedSet = useMemo(() => new Set(ticked), [ticked]);
  const disabledSet = useMemo(() => new Set(disabled), [disabled]);

  return (
    <div style={{ border: '1px solid var(--color-border-hairline)', borderRadius: '2px', padding: '8px', marginBottom: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
          <span style={{ fontSize: '12px', fontFamily: 'var(--font-body)', color: 'var(--color-fg)', fontWeight: 600 }}>
            {srv.name}
          </span>
          <span style={{ fontSize: '10px', fontFamily: 'var(--font-code)', color: 'var(--color-fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {srv.command} {srv.args.join(' ')}
            {srv.envKeys.length > 0 ? `  · ${srv.envKeys.length} env var${srv.envKeys.length === 1 ? '' : 's'}` : ''}
          </span>
        </div>
        <button type="button" onClick={onRemove} style={btnStyle} title="Remove from registry">remove</button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginTop: '8px', flexWrap: 'wrap' }}>
        <label style={labelStyle}>
          <input type="checkbox" checked={srv.enabled} onChange={(e) => onToggleGlobal(e.target.checked)} />
          enabled (global)
        </label>
        <label style={{ ...labelStyle, opacity: srv.enabled ? 1 : 0.4 }}>
          <input type="checkbox" checked={enabledForTab} disabled={!srv.enabled} onChange={(e) => onToggleTab(e.target.checked)} />
          enable for this tab
        </label>
        <button type="button" onClick={onProbe} style={btnStyle}>probe</button>
      </div>

      {probe && (
        <div style={{ fontSize: '10px', fontFamily: 'var(--font-body)', color: probe.ok ? 'var(--color-fg-muted)' : 'var(--color-danger, #c0392b)', marginTop: '6px' }}>
          {probe.ok
            ? `connected · ${probe.tools.length} tool${probe.tools.length === 1 ? '' : 's'}${disabledSet.size > 0 ? ` · ${disabledSet.size} disabled` : ''}`
            : `probe failed: ${probe.error ?? 'unknown error'}`}
        </div>
      )}
      {!probe && disabledSet.size > 0 && (
        <div style={{ fontSize: '10px', fontFamily: 'var(--font-body)', color: 'var(--color-fg-muted)', marginTop: '6px' }}>
          {disabledSet.size} tool{disabledSet.size === 1 ? '' : 's'} disabled
        </div>
      )}

      {tools.length > 0 && (
        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {tools.map((t) => {
            const isDisabled = disabledSet.has(t.name);
            return (
            <div key={t.name} style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' }}>
              {t.dangerous ? (
                <label style={{ ...labelStyle, opacity: enabledForTab && !isDisabled ? 1 : 0.4 }} title={t.description}>
                  <input
                    type="checkbox"
                    checked={tickedSet.has(t.name)}
                    disabled={!enabledForTab || isDisabled}
                    onChange={(e) => onTickDangerous(t.name, e.target.checked)}
                  />
                  <span style={{ fontFamily: 'var(--font-code)', fontSize: '10px', textDecoration: isDisabled ? 'line-through' : 'none' }}>{t.name}</span>
                  <span style={{ fontSize: '9px', color: 'var(--color-danger, #c0392b)', letterSpacing: '0.5px' }}>DANGEROUS</span>
                  {codexGap && <span style={{ fontSize: '9px', color: 'var(--color-fg-muted)' }}>(not gated on Codex)</span>}
                </label>
              ) : (
                <span style={{ fontFamily: 'var(--font-code)', fontSize: '10px', color: 'var(--color-fg-muted)', textDecoration: isDisabled ? 'line-through' : 'none' }} title={t.description}>
                  {t.name}
                </span>
              )}
              {/* DD11b — per-tab disable toggle (hides the tool from the model). */}
              <button
                type="button"
                onClick={() => onToggleDisabled(t.name, !isDisabled)}
                disabled={!enabledForTab}
                style={{ ...btnStyle, opacity: enabledForTab ? 1 : 0.4, flexShrink: 0 }}
                title={isDisabled ? 'Re-enable this tool for this tab' : 'Hide this tool from the model on this tab'}
              >
                {isDisabled ? 'enable' : 'disable'}
              </button>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AddServerForm({ onCreate }: { onCreate: (input: { name: string; command: string; args: string[]; env?: Record<string, string>; enabled?: boolean }) => void }) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [open, setOpen] = useState(false);

  const submit = () => {
    const cmd = command.trim();
    if (!cmd) return;
    // Whitespace-split argv. Operators needing quoted args with spaces can edit
    // the registry file directly; the common case (flags + paths) is space-safe.
    const args = argsText.trim().length > 0 ? argsText.trim().split(/\s+/) : [];
    onCreate({ name: name.trim() || cmd, command: cmd, args, enabled: false });
    setName(''); setCommand(''); setArgsText(''); setOpen(false);
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} style={{ ...btnStyle, marginTop: '4px' }}>
        + add MCP server
      </button>
    );
  }

  return (
    <div style={{ border: '1px dashed var(--color-border-hairline)', borderRadius: '2px', padding: '8px', marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <input style={inputStyle} placeholder="name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
      <input style={inputStyle} placeholder="command (e.g. npx, node, /abs/path)" value={command} onChange={(e) => setCommand(e.target.value)} />
      <input style={inputStyle} placeholder="args (space-separated, e.g. -y some-mcp-server)" value={argsText} onChange={(e) => setArgsText(e.target.value)} />
      <div style={{ display: 'flex', gap: '8px' }}>
        <button type="button" onClick={submit} style={btnStyle}>add</button>
        <button type="button" onClick={() => setOpen(false)} style={btnStyle}>cancel</button>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '3px 9px', fontSize: '10px', fontFamily: 'var(--font-body)',
  border: '1px solid var(--color-border-hairline)', background: 'transparent',
  color: 'var(--color-fg)', cursor: 'pointer', borderRadius: '2px',
};

const labelStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '5px', fontSize: '10px',
  fontFamily: 'var(--font-body)', color: 'var(--color-fg)', cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
  padding: '4px 8px', fontSize: '11px', fontFamily: 'var(--font-code)',
  background: 'transparent', border: '1px solid var(--color-border-hairline)',
  color: 'var(--color-fg)', borderRadius: '2px',
};
