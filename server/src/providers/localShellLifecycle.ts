// Local Bash is a foreground tool. Keep its teardown reachable from tab close
// until both the process pipes and platform tree-kill operation have settled.
interface LocalShell {
  stop: () => Promise<void>;
  ended: Promise<void>;
}
const shells = new Map<string, Set<LocalShell>>();

export function trackLocalShell(workflowId: string | undefined, shell: LocalShell): () => void {
  if (!workflowId) return () => {};
  let owned = shells.get(workflowId);
  if (!owned) { owned = new Set(); shells.set(workflowId, owned); }
  owned.add(shell);
  return () => {
    owned.delete(shell);
    if (owned.size === 0 && shells.get(workflowId) === owned) shells.delete(workflowId);
  };
}

export async function disposeLocalShells(workflowId: string): Promise<void> {
  const owned = [...(shells.get(workflowId) ?? [])];
  if (owned.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(owned.map(async shell => { await shell.stop(); await shell.ended; })),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 15_000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
