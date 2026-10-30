import { useEffect } from 'react';
import { create } from 'zustand';
import type { AuthStatusByProvider, ClaudeCredentialBinding, ClaudeNativeAuthFlow } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { refreshClaudeAllowance } from '../utils/claudeAllowance';

type Session = { generation: number; busy: boolean; flow?: ClaudeNativeAuthFlow; authorizationUrl?: string; hint?: string; error?: string };
let latestStart = 0;
export const useNativeLoginStore = create<{ sessions: Record<string, Session> }>(() => ({ sessions: {} }));
function update(owner: string, generation: number, patch: Partial<Session>): boolean {
  const state = useNativeLoginStore.getState(), previous = state.sessions[owner];
  if (previous?.generation !== generation) return false;
  useNativeLoginStore.setState({ sessions: { ...state.sessions, [owner]: { ...previous, ...patch } } });
  return true;
}
export function sameRecoveryBinding(a?: ClaudeCredentialBinding, b?: ClaudeCredentialBinding): boolean {
  return !!a && !!b && a.source === b.source && a.storeId === b.storeId && a.revision === b.revision;
}
export function nativeFlowPending(flow?: ClaudeNativeAuthFlow): boolean { return flow?.status === 'pending' || flow?.status === 'exchanging'; }

async function acceptFlow(owner: string, generation: number, flow: ClaudeNativeAuthFlow): Promise<void> {
  const previous = useNativeLoginStore.getState().sessions[owner];
  if (previous?.generation !== generation || previous.flow?.id !== flow.id || !sameRecoveryBinding(previous.flow.bindingBefore, flow.bindingBefore)
      || previous.flow.workflowId !== flow.workflowId || !nativeFlowPending(previous.flow)) return;
  if (previous.flow.status === 'exchanging' && flow.status === 'pending') return;
  if (flow.status === 'complete') {
    // Completion proves this grant was exchanged, not that a workflow ran.
    const res = await fetch('/api/auth-status', { cache: 'no-store' });
    if (!res.ok) throw new Error('Sign-in completed; status refresh failed. Check again.');
    const auth = await res.json() as AuthStatusByProvider;
    const current = useNativeLoginStore.getState().sessions[owner];
    if (current?.generation !== generation || current.flow?.id !== flow.id || !nativeFlowPending(current.flow)) return;
    if (!sameRecoveryBinding(auth.claude?.native?.binding, flow.binding)) {
      update(owner, generation, { flow: { ...flow, status: 'superseded' }, busy: false, error: 'Native credentials changed after this flow. Review the current sign-in.' });
      return;
    }
    const observed = useAppStore.getState().authStatus?.claude?.native;
    if (observed && auth.claude.native && observed.checkedAt > auth.claude.native.checkedAt && !sameRecoveryBinding(observed.binding, auth.claude.native.binding)) {
      update(owner, generation, { flow: { ...flow, status: 'superseded' }, busy: false, error: 'A newer Native credential observation replaced this flow.' });
      return;
    }
    useAppStore.getState().setAuthStatus(auth);
    void refreshClaudeAllowance(true).then(usage => { if (usage) useAppStore.getState().setUsage(usage); }).catch(() => {});
  }
  update(owner, generation, { flow, busy: false, error: flow.error });
}

export function useClaudeNativeLogin(owner: string, workflowId?: string, binding?: ClaudeCredentialBinding) {
  const session = useNativeLoginStore(s => s.sessions[owner]);
  useEffect(() => {
    if (!nativeFlowPending(session?.flow)) return;
    const generation = session!.generation, id = session!.flow!.id;
    let disposed = false, checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const res = await fetch(`/api/auth/claude-native/flow?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
        const data = await res.json() as { flow?: ClaudeNativeAuthFlow; error?: string };
        if (disposed) return;
        if (!res.ok || !data.flow) { update(owner, generation, { flow: { ...session!.flow!, status: 'expired' }, error: data.error || 'Sign-in flow unavailable. Start again.', busy: false }); return; }
        await acceptFlow(owner, generation, data.flow);
      } catch { if (!disposed) update(owner, generation, { error: 'Could not check sign-in completion. Retrying; manual paste remains available.' }); }
      finally { checking = false; }
    };
    const timer = setInterval(() => { void check(); }, 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [owner, session?.generation, session?.flow?.id, session?.flow?.status]);

  const start = async () => {
    const sequence = ++latestStart;
    const generation = (useNativeLoginStore.getState().sessions[owner]?.generation ?? 0) + 1;
    const sessions = { ...useNativeLoginStore.getState().sessions, [owner]: { generation, busy: true } };
    // Bound in-memory UI history; OAuth authorization URLs are never persisted.
    for (const key of Object.keys(sessions).slice(0, Math.max(0, Object.keys(sessions).length - 32))) if (key !== owner) delete sessions[key];
    useNativeLoginStore.setState({ sessions });
    try {
      const res = await fetch('/api/auth/claude-native/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ binding, workflowId }) });
      const data = await res.json() as { flow?: ClaudeNativeAuthFlow; authorizationUrl?: string; manualReason?: string; error?: string };
      if (!res.ok || !data.flow || !data.authorizationUrl) throw new Error(data.error || 'Could not start Native sign-in.');
      if (sequence !== latestStart) { update(owner, generation, { busy: false, error: 'Another Native sign-in request replaced this start. Review its status.' }); return; }
      const current = useNativeLoginStore.getState().sessions;
      useNativeLoginStore.setState({ sessions: Object.fromEntries(Object.entries(current).map(([key, value]) => [key, key !== owner && nativeFlowPending(value.flow) ? { ...value, flow: { ...value.flow!, status: 'superseded' }, busy: false } : value])) });
      if (!update(owner, generation, { flow: data.flow, authorizationUrl: data.authorizationUrl, busy: false, hint: data.manualReason })) return;
      try { window.open(data.authorizationUrl, '_blank', 'noopener'); } catch { /* link and manual paste remain available */ }
    } catch (err) { update(owner, generation, { busy: false, error: err instanceof Error ? err.message : 'Could not start Native sign-in.' }); }
  };
  const submit = async (url: string) => {
    if (!session?.flow || !nativeFlowPending(session.flow) || !url.trim()) return;
    const generation = session.generation;
    update(owner, generation, { busy: true, error: undefined });
    try {
      const res = await fetch('/api/auth/claude-native/callback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.trim(), flowId: session.flow.id }) });
      const data = await res.json() as { flow?: ClaudeNativeAuthFlow; error?: string };
      if (!res.ok || !data.flow) throw new Error(data.error || 'Manual callback did not complete.');
      await acceptFlow(owner, generation, data.flow);
    } catch (err) { update(owner, generation, { busy: false, error: err instanceof Error ? err.message : 'Manual callback did not complete.' }); }
  };
  const cancel = async () => {
    if (!session?.flow) return;
    try {
      const res = await fetch(`/api/auth/claude-native/flow?id=${encodeURIComponent(session.flow.id)}`, { method: 'DELETE' });
      const data = await res.json() as { flow?: ClaudeNativeAuthFlow };
      if (!res.ok || !data.flow) throw new Error();
      await acceptFlow(owner, session.generation, data.flow);
    } catch { update(owner, session.generation, { error: 'Could not cancel sign-in. Check its status before starting again.' }); }
  };
  return { session, start, submit, cancel };
}
