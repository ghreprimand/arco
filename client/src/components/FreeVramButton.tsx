import { useState } from 'react';
import type { LocalModelUnloadReport } from '@arco/shared';
import { useAppStore } from '../stores/appStore';

const isLocal = (provider?: string) => provider === 'ollama' || provider === 'strata' || provider === 'deepseek' || provider === 'llamacpp' || provider === 'lmstudio';

export function FreeVramButton() {
  const connected = useAppStore((s) => s.connected);
  const activeLocal = useAppStore((s) => Object.values(s.jobs).some((j) =>
    (j.busy && isLocal(j.config.primaryProvider)) ||
    Object.values(j.workers).some((w) => isLocal(w.provider) && (w.status === 'running' || w.status === 'spawning'))));
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [unloading, setUnloading] = useState(false);
  const [result, setResult] = useState('');
  const unload = async () => {
    if (unloading || activeLocal || !connected) return;
    setUnloading(true); setResult('');
    try {
      const res = await fetch('/api/local-models/unload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const report = await res.json() as LocalModelUnloadReport;
      if (!res.ok || report.blocked) throw new Error(report.error || 'Could not unload local models');
      const summary = report.results.map((r) => `${r.provider}: ${r.state}${r.detail ? ` (${r.detail})` : ''}`).join('; ');
      const freed = report.results.filter((r) => r.state === 'unloaded').length;
      setResult(summary);
      pushNotification(report.results.some((r) => r.state === 'failed') ? 'error' : 'info', `FREE VRAM: ${freed} model${freed === 1 ? '' : 's'} unloaded. ${summary}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setResult(message); pushNotification('error', message);
    } finally { setUnloading(false); }
  };
  const disabled = !connected || activeLocal || unloading;
  return <span data-help="header.free-vram" style={{ display: 'inline-flex' }}><button
    onClick={() => void unload()}
    disabled={disabled}
    className="display-font"
    title={activeLocal ? 'Finish or cancel active local model turns before freeing VRAM.' : result || 'Unload local Ollama, Qwen/Strata, DeepSeek/Xolotl, llama.cpp and LM Studio models. Model files stay on disk; the next request reloads. Remote endpoints are skipped.'}
    style={{ background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-accent-primary-dim)', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, fontSize: '10px', letterSpacing: '1px', padding: '3px 8px' }}
  >{unloading ? 'FREEING VRAM…' : 'FREE VRAM'}</button></span>;
}
