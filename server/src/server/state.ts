// Module-level singleton state for the server.
//
// These Maps were previously declared inline in index.ts and closed over by
// the ~60 handlers, the HTTP router, the WS connection loop, and the fan-out
// primitives. Hoisting them into a leaf module (no imports back into index.ts)
// lets those subsystems move into their own files while sharing one instance:
// ES module bindings are live, so `workflows.set(...)` from any importer
// mutates the same registry. See docs/FILE_SIZE_REFACTOR_PLAN.md Phase 4.

import type { WebSocket } from 'ws';
import type { Session, WorkflowState, CwdHandoffSlot, PlansWatcher } from '../workflows/types.js';

export const sessions = new Map<WebSocket, Session>();

// Global workflow registry. Keyed by workflowId so state survives WS
// disconnects (HMR, reconnect, tab hide). Previously workflows lived in
// session.workflows — a new Session on reconnect meant a fresh WorkflowState
// with an empty queue, even though the old session still held an
// in-flight turn. That manifested as mid-turn sends silently killing the
// drain (queued into the orphaned state, never flushed). Registry-first
// model + observer pointer fixes it.
export const workflows = new Map<string, WorkflowState>();

// workflowId → cwd lookup used by send() to resolve the events.jsonl path
// without needing per-call session context.
export const workflowCwds = new Map<string, string>();

export const commitCountCache = new Map<string, { count: number; ts: number }>();

// 2026-05-12 — per-cwd handoff serialization. Two cluster members sharing a
// cwd would otherwise race to read git state + prepend DEVLOG.md, observing
// each other's mid-handoff writes and producing duplicate / re-ordered
// DEVLOG entries. Each handoff appends to this chain; the next handoff in
// the same cwd waits for the prior promise before starting. Cleared when
// the chain tail resolves (so unused cwds don't leak Promise objects).
export const cwdHandoffChain = new Map<string, CwdHandoffSlot>();

// Per-cwd fsWatch over <cwd>/.archon/plans, ref-counted across attached
// workflows + clusters. Read by the HTTP plan routes (skipNext dedupe) and
// the cluster plan watcher in broadcast.ts.
export const plansWatchers = new Map<string, PlansWatcher>();
export const clusterPlanWatcherCwds = new Map<string, string>();
