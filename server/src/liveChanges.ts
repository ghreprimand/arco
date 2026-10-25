import { WebSocket } from 'ws';
import type { LiveChangesSnapshotMessage, LiveChangesSubscribeMessage, LiveChangesUnsubscribeMessage, WorkingChangesResponse } from '@arco/shared';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getWorkingChanges } from './gitWorking.js';
import { workflowCwds } from './server/state.js';

const INTERVAL_MS = 1000;

interface LiveSlot {
  workflowId: string;
  cwd: string;
  sockets: Set<WebSocket>;
  timer: ReturnType<typeof setInterval>;
  running: boolean;
  lastSig: string;
}

const slots = new Map<string, LiveSlot>();
const socketKeys = new Map<WebSocket, Set<string>>();

export function handleLiveChangesSubscribe(ws: WebSocket, msg: LiveChangesSubscribeMessage): void {
  const cwd = resolveCwd(msg.workflowId, msg.cwd);
  if (!cwd) {
    sendOne(ws, {
      type: 'live_changes_snapshot',
      workflowId: msg.workflowId,
      cwd: msg.cwd ?? '',
      ts: Date.now(),
      data: { isRepo: false, staged: [], unstaged: [], untracked: [] },
    });
    return;
  }
  const key = slotKey(msg.workflowId, cwd);
  let slot = slots.get(key);
  if (!slot) {
    slot = {
      workflowId: msg.workflowId,
      cwd,
      sockets: new Set(),
      timer: setInterval(() => { void pollSlot(key, false); }, INTERVAL_MS),
      running: false,
      lastSig: '',
    };
    slots.set(key, slot);
  }
  slot.sockets.add(ws);
  let keys = socketKeys.get(ws);
  if (!keys) {
    keys = new Set();
    socketKeys.set(ws, keys);
  }
  keys.add(key);
  void pollSlot(key, true);
}

export function handleLiveChangesUnsubscribe(ws: WebSocket, msg: LiveChangesUnsubscribeMessage): void {
  const cwd = resolveCwd(msg.workflowId, msg.cwd);
  if (!cwd) return;
  releaseSocketKey(ws, slotKey(msg.workflowId, cwd));
}

export function releaseLiveChangesForSocket(ws: WebSocket): void {
  const keys = socketKeys.get(ws);
  if (!keys) return;
  for (const key of Array.from(keys)) releaseSocketKey(ws, key);
  socketKeys.delete(ws);
}

function resolveCwd(workflowId: string, cwd: string | undefined): string {
  return cwd?.trim() || workflowCwds.get(workflowId) || '';
}

function slotKey(workflowId: string, cwd: string): string {
  return `${workflowId}\0${cwd}`;
}

function releaseSocketKey(ws: WebSocket, key: string): void {
  const slot = slots.get(key);
  if (slot) {
    slot.sockets.delete(ws);
    if (slot.sockets.size === 0) {
      clearInterval(slot.timer);
      slots.delete(key);
    }
  }
  const keys = socketKeys.get(ws);
  if (keys) {
    keys.delete(key);
    if (keys.size === 0) socketKeys.delete(ws);
  }
}

async function pollSlot(key: string, force: boolean): Promise<void> {
  const slot = slots.get(key);
  if (!slot || slot.running) return;
  slot.running = true;
  try {
    const data = await getWorkingChanges(slot.cwd);
    const fingerprints = await fileFingerprints(slot.cwd, data);
    const sig = statusSignature(data, fingerprints);
    if (!force && sig === slot.lastSig) return;
    slot.lastSig = sig;
    const msg: LiveChangesSnapshotMessage = {
      type: 'live_changes_snapshot',
      workflowId: slot.workflowId,
      cwd: slot.cwd,
      ts: Date.now(),
      data,
      fingerprints,
    };
    const payload = JSON.stringify(msg);
    for (const ws of Array.from(slot.sockets)) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      } else {
        releaseSocketKey(ws, key);
      }
    }
  } catch (err) {
    const msg: LiveChangesSnapshotMessage = {
      type: 'live_changes_snapshot',
      workflowId: slot.workflowId,
      cwd: slot.cwd,
      ts: Date.now(),
      data: { isRepo: false, staged: [], unstaged: [], untracked: [] },
    };
    const payload = JSON.stringify(msg);
    for (const ws of Array.from(slot.sockets)) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
    console.error(`[arco] live changes poll failed for ${slot.cwd}:`, err);
  } finally {
    const current = slots.get(key);
    if (current) current.running = false;
  }
}

async function fileFingerprints(cwd: string, data: WorkingChangesResponse): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const rows: Array<{ group: 'staged' | 'unstaged' | 'untracked'; path: string }> = [
    ...data.staged.map((f) => ({ group: 'staged' as const, path: f.path })),
    ...data.unstaged.map((f) => ({ group: 'unstaged' as const, path: f.path })),
    ...data.untracked.map((f) => ({ group: 'untracked' as const, path: f.path })),
  ];
  await Promise.all(rows.map(async (row) => {
    const key = `${row.group}:${row.path}`;
    try {
      const st = await fs.stat(path.join(cwd, row.path));
      out[key] = `${st.size}:${Math.trunc(st.mtimeMs)}`;
    } catch {
      out[key] = 'missing';
    }
  }));
  return out;
}

function statusSignature(data: WorkingChangesResponse, fingerprints: Record<string, string>): string {
  const rows = [
    ...data.staged.map((f) => `S:${f.status}:${f.path}:${f.origPath ?? ''}:${fingerprints[`staged:${f.path}`] ?? ''}`),
    ...data.unstaged.map((f) => `U:${f.status}:${f.path}:${f.origPath ?? ''}:${fingerprints[`unstaged:${f.path}`] ?? ''}`),
    ...data.untracked.map((f) => `N:${f.status}:${f.path}:${f.origPath ?? ''}:${fingerprints[`untracked:${f.path}`] ?? ''}`),
  ];
  rows.sort();
  return `${data.isRepo ? '1' : '0'}|${rows.join('|')}`;
}

function sendOne(ws: WebSocket, msg: LiveChangesSnapshotMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
