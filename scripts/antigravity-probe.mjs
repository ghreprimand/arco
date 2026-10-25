#!/usr/bin/env node
// Slice 0 probe for the Antigravity integration plan.
//
// Watches ~/.gemini/antigravity/brain/ recursively for a fixed duration
// and logs every create/modify with path, size, mtime, and a snippet of any
// .metadata.json sibling. Writes to both stdout and scripts/antigravity-probe.log.
//
// Usage:
//   node scripts/antigravity-probe.mjs [duration_seconds]
//
// Run this, then send a short prompt in Antigravity (ideally asking it to
// "Name your primary artifact arco_probe_<timestamp>.md") and observe
// the event stream. Goal: answer §9.1-9.3 open questions in the plan.

import { watch, statSync, readFileSync, existsSync, createWriteStream, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const BRAIN_ROOT = join(homedir(), '.gemini', 'antigravity', 'brain');
const DURATION_SEC = Number(process.argv[2] ?? 300);
const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(HERE, 'antigravity-probe.log');

if (!existsSync(BRAIN_ROOT)) {
  console.error(`brain dir not found: ${BRAIN_ROOT}`);
  process.exit(1);
}

mkdirSync(dirname(LOG_PATH), { recursive: true });
const logStream = createWriteStream(LOG_PATH, { flags: 'a' });

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  logStream.write(stamped + '\n');
}

log('─'.repeat(72));
log(`probe start · watching ${BRAIN_ROOT} · duration ${DURATION_SEC}s`);

// Snapshot existing state so we can distinguish "already there" from "new".
const before = new Set();
try {
  for (const uuid of readdirSync(BRAIN_ROOT)) before.add(uuid);
} catch { /* ignore */ }
log(`pre-existing conversation uuids: ${before.size}`);
for (const u of before) log(`  · ${u}`);

// Track events per file so we can compute inter-event gaps (idle window).
const lastSeen = new Map();

function describe(fullPath) {
  try {
    const st = statSync(fullPath);
    const rel = fullPath.slice(BRAIN_ROOT.length + 1);
    const parts = [`${rel}`, `${st.size}B`, `mtime=${st.mtimeMs.toFixed(0)}`];
    const prev = lastSeen.get(fullPath);
    if (prev) parts.push(`Δ=${(st.mtimeMs - prev).toFixed(0)}ms`);
    lastSeen.set(fullPath, st.mtimeMs);
    // If this is a metadata file, pluck the summary for context.
    if (rel.endsWith('.metadata.json')) {
      try {
        const meta = JSON.parse(readFileSync(fullPath, 'utf8'));
        parts.push(`type=${meta.artifactType ?? '?'}`);
        if (meta.summary) parts.push(`summary=${JSON.stringify(meta.summary.slice(0, 60))}`);
      } catch { /* partial write — ignore */ }
    }
    return parts.join(' · ');
  } catch {
    return `${fullPath} [stat failed — likely deleted]`;
  }
}

const watcher = watch(BRAIN_ROOT, { recursive: true }, (event, filename) => {
  if (!filename) return;
  const full = join(BRAIN_ROOT, filename);
  const isKnownUuid = before.has(filename.split('/')[0] ?? '');
  const newnessTag = isKnownUuid ? '(existing-uuid)' : '(NEW-UUID)';
  log(`${event.padEnd(6)} ${newnessTag} ${describe(full)}`);
});

watcher.on('error', (err) => {
  log(`watcher error: ${err.message}`);
});

setTimeout(() => {
  log(`probe end · ${DURATION_SEC}s elapsed`);
  watcher.close();
  logStream.end();
  process.exit(0);
}, DURATION_SEC * 1000);

process.on('SIGINT', () => {
  log('probe interrupted by SIGINT');
  watcher.close();
  logStream.end();
  process.exit(0);
});
