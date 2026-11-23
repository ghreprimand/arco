export function GeminiSubagentLine({ input }: { input?: Record<string, unknown> }) {
  const role = String(input?.Role ?? input?.role ?? input?.agent_type ?? input?.subagent_type ?? 'Agent');
  const prompt = String(input?.Prompt ?? input?.prompt ?? input?.task ?? input?.description ?? '');
  return <div title={prompt} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '11px', color: 'var(--color-fg-muted)' }}>Sub-agent: {role} - {prompt.replace(/\s+/g, ' ')}</div>;
}
