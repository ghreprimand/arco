import { readFile, readdir, stat } from 'fs/promises';
import { openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import type { SessionInfo } from '@arco/shared';
import { UUID_PATTERN, CODEX_SCAN_DAYS } from '../server/constants.js';
import { accountShortLabel, configuredAccounts, resolveProviderAccount } from '../providerAccounts.js';
import { discoverGeminiSessions } from '../providers/gemini.js';
import { listWorkflowMetas, readMeta, arcoInternalSessionInfoForMeta } from '../workflowMeta.js';
import { backfillSessionIndex } from './sessionIndex.js';
import { getRecallIndex } from '../recall/index.js';
import { encodeProjectDir } from '../http/fileRead.js';
import { extractUserText } from './transcripts.js';

export async function extractSessionName(
  path: string,
): Promise<{ name: string; aiTitle?: string; lastUserPreview?: string; firstTs?: number }> {
  // Claude's ai-title is written at most once per session — many sessions
  // never get one (observed: heavy tool-use sessions >1MB with zero ai-title
  // entries). To give the picker something that actually updates as work
  // progresses, we also extract the LATEST user message as a dynamic
  // preview. Picker renders aiTitle (when present) OR the first-user
  // message as the primary title, and prefers lastUserPreview as the
  // secondary subtitle so "what am I working on right now" is visible.
  const PREFIX_BYTES = 128 * 1024;
  const LAST_USER_TAIL_BYTES = 256 * 1024;
  try {
    const buf = await readFile(path);
    const fullText = buf.toString('utf-8');

    let aiTitle: string | undefined;
    const titleRe = /\{"type":"ai-title"[^\n]*\}/g;
    let m: RegExpExecArray | null;
    while ((m = titleRe.exec(fullText)) !== null) {
      try {
        const entry = JSON.parse(m[0]);
        if (typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
          aiTitle = entry.aiTitle.trim();
        }
      } catch { /* skip */ }
    }

    const prefix = buf.subarray(0, Math.min(buf.length, PREFIX_BYTES)).toString('utf-8');
    let firstUser = '';
    let firstTs: number | undefined;
    for (const line of prefix.split('\n')) {
      if (!line) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (firstTs === undefined && typeof entry.timestamp === 'string') {
        const t = Date.parse(entry.timestamp);
        if (!Number.isNaN(t)) firstTs = t;
      }
      if (!firstUser && entry.type === 'user' && entry.message?.content) {
        const content = extractUserText(entry.message.content);
        if (content) firstUser = content.slice(0, 80);
      }
      if (firstUser && firstTs !== undefined) break;
    }

    // Scan the TAIL of the file for the most recent user message. Tail-only
    // keeps this cheap on 10MB+ sessions. Falls back to full scan when the
    // file is small.
    const tailStart = Math.max(0, buf.length - LAST_USER_TAIL_BYTES);
    const tailText = buf.subarray(tailStart).toString('utf-8');
    // A partial JSON line at the start of the tail slice is unparseable;
    // skip it by dropping everything before the first newline when the tail
    // isn't the whole file.
    const tailLines = (tailStart === 0 ? tailText : tailText.slice(tailText.indexOf('\n') + 1)).split('\n');
    let lastUserPreview: string | undefined;
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const line = tailLines[i];
      if (!line || !line.includes('"type":"user"')) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== 'user' || !entry.message?.content) continue;
      const content = extractUserText(entry.message.content);
      if (!content) continue;
      lastUserPreview = content.slice(0, 80);
      break;
    }
    // Don't bother surfacing lastUserPreview when it's the same as the
    // primary title (short conversations, one-shot sessions).
    const primary = aiTitle ?? firstUser;
    if (lastUserPreview && lastUserPreview === primary) lastUserPreview = undefined;

    return { name: primary, aiTitle, lastUserPreview, firstTs };
  } catch {
    return { name: '' };
  }
}

export async function discoverClaudeSessions(resolvedCwd: string): Promise<SessionInfo[]> {
  const projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(resolvedCwd));
  const results: SessionInfo[] = [];
  let files: string[];
  try {
    files = await readdir(projectDir);
  } catch {
    return [];
  }
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const sessionId = file.slice(0, -'.jsonl'.length);
    if (!UUID_PATTERN.test(sessionId)) continue;
    const path = join(projectDir, file);
    try {
      const st = await stat(path);
      if (st.size === 0) continue;
      const { name, aiTitle, lastUserPreview, firstTs } = await extractSessionName(path);
      results.push({
        sessionId,
        cwd: resolvedCwd,
        name,
        aiTitle,
        lastUserPreview,
        startedAt: st.mtimeMs || firstTs || 0,
        provider: 'claude',
      });
    } catch {
      /* skip unreadable */
    }
  }
  return results;
}

// Codex rollouts live at ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl.
// Each file's first line is a `session_meta` event with `{id, cwd, timestamp}`.

export async function discoverCodexSessionsInHome(
  resolvedCwd: string,
  codexHome: string,
  account?: { id: string; label: string; shortLabel?: string },
): Promise<SessionInfo[]> {
  const root = join(codexHome, 'sessions');
  const results: SessionInfo[] = [];
  const now = new Date();
  for (let i = 0; i < CODEX_SCAN_DAYS; i++) {
    const d = new Date(now.getTime() - i * 86400_000);
    const yyyy = String(d.getUTCFullYear());
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const dayDir = join(root, yyyy, mm, dd);
    let files: string[];
    try {
      files = await readdir(dayDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
      const path = join(dayDir, file);
      try {
        const info = await extractCodexSessionInfo(path, resolvedCwd);
        if (info) {
          results.push({
            ...info,
            ...(account ? {
              providerAccountRef: account.id,
              providerAccountLabel: account.label,
              providerAccountShortLabel: account.shortLabel,
            } : {}),
          });
        }
      } catch {
        /* skip unreadable */
      }
    }
  }
  return results;
}

export async function discoverCodexSessions(resolvedCwd: string): Promise<SessionInfo[]> {
  const accounts = await configuredAccounts('codex', resolvedCwd).catch(() => []);
  if (accounts.length === 0) {
    return discoverCodexSessionsInHome(resolvedCwd, join(homedir(), '.codex'));
  }
  const lists = await Promise.all(accounts.map(async (profile) => {
    const resolved = await resolveProviderAccount('codex', profile.id, resolvedCwd).catch(() => null);
    if (!resolved?.codexHome) return [];
    return discoverCodexSessionsInHome(resolvedCwd, resolved.codexHome, {
      id: profile.id,
      label: profile.label,
      shortLabel: accountShortLabel(profile),
    });
  }));
  return lists.flat();
}

export async function extractCodexSessionInfo(path: string, wantCwd: string): Promise<SessionInfo | null> {
  const MAX_BYTES = 64 * 1024;
  const buf = await readFile(path);
  const slice = buf.subarray(0, Math.min(buf.length, MAX_BYTES)).toString('utf-8');
  const lines = slice.split('\n');
  let sessionId: string | undefined;
  let startedAt = 0;
  let cwd: string | undefined;
  let firstUser: string | undefined;
  for (const line of lines) {
    if (!line) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === 'session_meta' && entry.payload) {
      sessionId = typeof entry.payload.id === 'string' ? entry.payload.id : undefined;
      cwd = typeof entry.payload.cwd === 'string' ? entry.payload.cwd : undefined;
      const ts = typeof entry.payload.timestamp === 'string' ? Date.parse(entry.payload.timestamp) : NaN;
      if (!Number.isNaN(ts)) startedAt = ts;
    } else if (
      !firstUser &&
      entry.type === 'event_msg' &&
      entry.payload &&
      entry.payload.type === 'user_message' &&
      typeof entry.payload.message === 'string'
    ) {
      firstUser = entry.payload.message.trim().replace(/\s+/g, ' ').slice(0, 80);
      break;
    }
  }
  if (!sessionId || !UUID_PATTERN.test(sessionId)) return null;
  if (!cwd || resolve(cwd) !== wantCwd) return null;
  return {
    sessionId,
    cwd: wantCwd,
    name: firstUser ?? '',
    startedAt,
    provider: 'codex',
  };
}

// First operator message of a workflow, read straight from the HEAD of its
// events.jsonl (the first `user_message_echo`). Deterministic topic source for
// Arco-internal sessions that have no provider .jsonl and may not yet be in
// the recall index. Bounded head read, best-effort, never throws.
function readFirstUserText(cwd: string, wfid: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(join(cwd, '.arco', 'workflows', wfid, 'events.jsonl'), 'r');
    const size = fstatSync(fd).size;
    if (size === 0) return undefined;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, 0);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line || !line.includes('"user_message_echo"')) continue;
      try {
        const ev = JSON.parse(line) as { type?: string; content?: string };
        if (ev.type === 'user_message_echo' && typeof ev.content === 'string' && ev.content.trim()) {
          const t = ev.content.trim().replace(/\s+/g, ' ');
          return t.length > 80 ? t.slice(0, 79).trimEnd() + '…' : t;
        }
      } catch {
        /* skip unparseable line */
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export async function discoverSessions(targetDir: string): Promise<SessionInfo[]> {
  if (!targetDir) return [];
  const resolved = resolve(targetDir);
  // ARCO_OPS_PLAN.md §H1 — resume-discovery trigger. Refresh the project-local
  // session index for every workflow under this cwd (covers ones created by a
  // prior server process with no turn this run). Fired-and-logged, never awaited
  // into the picker result — the index is a rebuildable projection.
  void backfillSessionIndex(resolved, readMeta).catch((err) => {
    console.error('[arco] session index backfill failed:', err);
  });
  const [claude, codex, gemini, arcoMetas] = await Promise.all([
    discoverClaudeSessions(resolved),
    discoverCodexSessions(resolved),
    discoverGeminiSessions(resolved),
    listWorkflowMetas(resolved),
  ]);

  // Index native sessionId → arco workflow so the picker can display a
  // friendly workflow name and the server can reuse the existing wfid on
  // resume (rather than creating a duplicate meta.json for the same CLI
  // session).
  const claimedBy = new Map<string, { workflowId: string; name: string }>();
  for (const meta of arcoMetas) {
    if (meta.lastClaudeSessionId) {
      claimedBy.set(meta.lastClaudeSessionId, { workflowId: meta.workflowId, name: meta.name });
    }
  }

  // For Codex claims we need the full cliSessions[] (meta summaries only
  // expose the latest Claude entry). Read the meta.json directly.
  for (const meta of arcoMetas) {
    try {
      const full = await readMeta(resolved, meta.workflowId);
      if (!full) continue;
      for (const s of full.cliSessions) {
        if (!claimedBy.has(s.sessionId)) {
          claimedBy.set(s.sessionId, { workflowId: meta.workflowId, name: meta.name });
        }
      }
    } catch {
      /* skip unreadable meta */
    }
  }

  const all: SessionInfo[] = [...claude, ...codex, ...gemini].map((s) => {
    const claim = claimedBy.get(s.sessionId);
    return claim
      ? { ...s, arcoWorkflowId: claim.workflowId, arcoName: claim.name }
      : s;
  });
  const listedWorkflowIds = new Set(all.map((s) => s.arcoWorkflowId).filter((id): id is string => typeof id === 'string'));
  for (const meta of arcoMetas) {
    if (listedWorkflowIds.has(meta.workflowId)) continue;
    try {
      const full = await readMeta(resolved, meta.workflowId);
      if (!full) continue;
      const internal = arcoInternalSessionInfoForMeta(full);
      if (internal) {
        // Arco-internal sessions (Native / in-process) have no provider .jsonl
        // to mine, so their `name` defaults to the workflow name (= the cwd
        // folder, e.g. "Limits") — indistinguishable in the resume list. Borrow
        // the recall index's deterministic title (ai-title → first user message →
        // dated fallback; no LLM) so the picker shows the conversation's topic.
        // Prefer the recall title (includes Claude's ai-title when present);
        // fall back to the first operator message straight from events.jsonl so
        // even sessions not yet in the recall index get a real topic.
        let title: string | undefined;
        try {
          title = getRecallIndex().get(full.workflowId)?.title || undefined;
        } catch {
          /* recall unavailable → fall through */
        }
        if (!title) title = readFirstUserText(resolved, full.workflowId);
        all.push({ ...internal, cwd: resolved, ...(title ? { name: title } : {}) });
      }
    } catch {
      /* skip unreadable meta */
    }
  }
  return all.sort((a, b) => b.startedAt - a.startedAt);
}
