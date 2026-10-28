import { spawn, execFile } from 'child_process';
import { mkdir, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { CodexUsageInfo } from '@arco/shared';
import { arcoHome } from './arcoHome.js';
import { configuredAccounts, resolveProviderAccount } from './providerAccounts.js';
import { readCodexQuota, CodexQuotaError } from './codexUsageRpc.js';

// 2026-10: OpenAI moved live plan limits off the Codex analytics page (which
// now redirects to a daily-snapshot usage-history tab) onto settings/usage.
const ANALYTICS_URL = 'https://chatgpt.com/settings/usage?tab=overview';
const CAMOUFOX_PYTHON = process.env.ARCO_CAMOUFOX_PYTHON ?? '/opt/camoufox/bin/python';
const PROFILE_DIR = process.env.ARCO_CODEX_USAGE_PROFILE
  ?? join(arcoHome(), 'camoufox-chatgpt-profile');
const CACHE_MS = 3 * 60 * 1000;
const SCRAPE_TIMEOUT_MS = 45_000;

const quotaCache = new Map<string, { usage: CodexUsageInfo; identity: string; authStamp: string | null }>();

async function authFileStamp(home?: string): Promise<string | null> {
  try {
    const file = await stat(join(home ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'));
    return [file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs].join(':');
  } catch { return null; }
}
const quotaRequests = new Map<string, Promise<CodexUsageInfo>>();
let cached: CodexUsageInfo | null = null;

export async function getCodexUsage(force = false, accountRef?: string, source: 'appserver' | 'camoufox' = 'appserver'): Promise<CodexUsageInfo> {
  if (source === 'camoufox') return getBrowserUsage(force);
  const accounts = await configuredAccounts('codex');
  if (accountRef && !accounts.some(account => account.id === accountRef)) {
    return { available: false, fetchedAt: Date.now(), source: 'error', analyticsUrl: ANALYTICS_URL, error: 'Selected Codex account was removed. Choose an available account in Connections.' };
  }
  const resolved = await resolveProviderAccount('codex', accountRef);
  const key = JSON.stringify([resolved?.profile.id ?? '', resolved?.codexHome ?? process.env.CODEX_HOME ?? '__ambient__']);
  const previous = quotaCache.get(key);
  const inFlight = quotaRequests.get(key);
  if (inFlight) return inFlight;
  const request = (async () => {
    try {
      const { usage, identity } = await readCodexQuota(resolved?.codexHome);
      const result = { ...usage, ...(resolved ? { accountRef: resolved.profile.id, accountLabel: resolved.profile.label } : { accountLabel: 'Default CLI account' }) };
      quotaCache.set(key, { usage: result, identity, authStamp: await authFileStamp(resolved?.codexHome) });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Codex quota check failed.';
      const stamp = await authFileStamp(resolved?.codexHome);
      if (previous && stamp && stamp === previous.authStamp && err instanceof CodexQuotaError && err.identity && err.identity === previous.identity) {
        return { ...previous.usage, stale: true, error };
      }
      return { available: false, fetchedAt: Date.now(), source: 'unavailable' as const, analyticsUrl: ANALYTICS_URL, ...(resolved ? { accountRef: resolved.profile.id, accountLabel: resolved.profile.label } : { accountLabel: 'Default CLI account' }), error };
    }
  })().finally(() => quotaRequests.delete(key));
  quotaRequests.set(key, request);
  return request;
}

async function browserPrerequisite(): Promise<string | null> {
  return new Promise(resolve => {
    const probe = [
      'import sys',
      'import camoufox.sync_api',
      'from camoufox.pkgman import INSTALL_DIR, LAUNCH_FILE, OS_NAME',
      'roots = [INSTALL_DIR, *INSTALL_DIR.glob("browsers/*/*")]',
      'def executable(root):',
      '    base = root / "Camoufox.app" / "Contents" / "Resources" if OS_NAME == "mac" else root',
      '    return (base / LAUNCH_FILE[OS_NAME]).is_file()',
      'sys.exit(0 if any(executable(root) for root in roots) else 2)',
    ].join('\n');
    execFile(CAMOUFOX_PYTHON, ['-c', probe], { timeout: 5000, windowsHide: true }, err => {
      resolve(err ? 'Camoufox Python or its browser is unavailable. Follow the Codex usage setup guidance and configure ARCO_CAMOUFOX_PYTHON.' : null);
    });
  });
}

async function getBrowserUsage(force = false): Promise<CodexUsageInfo> {
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached;

  try {
    const prerequisite = await browserPrerequisite();
    if (prerequisite) throw new Error(prerequisite);
    await mkdir(PROFILE_DIR, { recursive: true });
    const stdout = await runScrape();
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      title?: string;
      url?: string;
      text?: string;
      cards?: Array<{ label: string; percent?: string; reset?: string; value?: string; text: string }>;
      error?: string;
    };
    if (!parsed.ok || !parsed.text) {
      return cache({
        available: false,
        fetchedAt: Date.now(),
        source: 'error',
        profileDir: PROFILE_DIR,
        analyticsUrl: ANALYTICS_URL,
        error: parsed.error ?? 'Codex analytics page returned no readable text. Use LOGIN CAMOUFOX PROFILE from the Codex hover.',
      });
    }
    const rows = parsePrimaryUsageWindows(parsed.text)
      ?? (parsed.cards?.length ? rowsFromCards(parsed.cards) : parseUsageRows(parsed.text));
    return cache({
      available: rows.length > 0,
      fetchedAt: Date.now(),
      source: 'camoufox',
      profileDir: PROFILE_DIR,
      analyticsUrl: ANALYTICS_URL,
      summary: summarizeRows(rows),
      rows,
      rawText: parsed.text.slice(0, 12_000),
      ...(rows.length === 0 ? { error: 'Loaded ChatGPT analytics, but no usage rows were recognized. Open analytics to inspect the page.' } : {}),
    });
  } catch (err) {
    return cache({
      available: false,
      fetchedAt: Date.now(),
      source: 'unavailable',
      profileDir: PROFILE_DIR,
      analyticsUrl: ANALYTICS_URL,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Runs the scrape in its own process group and kills the whole group on
// timeout. execFile's timeout only signalled the Python wrapper, orphaning
// camoufox-bin with the profile lock held — every scrape until it exited then
// failed with "Camoufox is already running, but is not responding" (2026-10).
function runScrape(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(CAMOUFOX_PYTHON, ['-c', scrapeScript(), PROFILE_DIR, ANALYTICS_URL], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    const killGroup = () => {
      try {
        if (process.platform === 'win32') {
          if (proc.pid) execFile('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true }, () => {});
          proc.kill('SIGKILL');
        } else if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
      } catch { /* already gone */ }
    };
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, SCRAPE_TIMEOUT_MS);
    proc.stdout.on('data', (d: Buffer) => { if (stdout.length < 512 * 1024) stdout += d; });
    proc.stderr.on('data', (d: Buffer) => { if (stderr.length < 16 * 1024) stderr += d; });
    proc.on('error', (err) => { clearTimeout(timer); killGroup(); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      // Reap any browser the wrapper left behind even on a clean exit.
      killGroup();
      if (timedOut) reject(new Error(`Codex usage scrape timed out after ${SCRAPE_TIMEOUT_MS / 1000}s`));
      else if (code !== 0) reject(new Error(stderr.trim().slice(-2000) || `Camoufox scrape exited with code ${code}`));
      else resolve(stdout);
    });
  });
}

export async function launchCodexUsageLogin(): Promise<{ started: boolean; profileDir: string; analyticsUrl: string; error?: string }> {
  try {
    const prerequisite = await browserPrerequisite();
    if (prerequisite) throw new Error(prerequisite);
    await mkdir(PROFILE_DIR, { recursive: true });
    const proc = spawn(CAMOUFOX_PYTHON, ['-c', loginScript(), PROFILE_DIR, ANALYTICS_URL], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    await new Promise<void>((resolve, reject) => { proc.once('spawn', resolve); proc.once('error', reject); });
    proc.unref();
    return { started: true, profileDir: PROFILE_DIR, analyticsUrl: ANALYTICS_URL };
  } catch (err) {
    return {
      started: false,
      profileDir: PROFILE_DIR,
      analyticsUrl: ANALYTICS_URL,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function cache(info: CodexUsageInfo): CodexUsageInfo {
  cached = info;
  return info;
}

function parseUsageRows(text: string): Array<{ label: string; value: string }> {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const rowsFromAdjacent = parseAdjacentRows(lines);
  if (rowsFromAdjacent.length > 0) return rowsFromAdjacent;

  const interesting = lines.filter((line) => {
    const lc = line.toLowerCase();
    return (
      lc.includes('usage') ||
      lc.includes('exec') ||
      lc.includes('cloud') ||
      lc.includes('local') ||
      lc.includes('limit') ||
      lc.includes('reset') ||
      lc.includes('remaining') ||
      lc.includes('used') ||
      /\b\d{1,3}%\b/.test(line)
    );
  });

  const rows: Array<{ label: string; value: string }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < interesting.length; i++) {
    const cur = interesting[i];
    const next = interesting[i + 1];
    let label = cur;
    let value = '';
    const pct = cur.match(/\b\d{1,3}%\b/);
    if (pct) {
      label = cur.replace(pct[0], '').trim() || 'Usage';
      value = pct[0];
    } else if (next && (/^\d/.test(next) || /\b\d{1,3}%\b/.test(next) || /reset|remaining|used/i.test(next))) {
      value = next;
      i++;
    }
    const key = `${label}:${value}`;
    if (!value || seen.has(key)) continue;
    seen.add(key);
    rows.push({ label: label.slice(0, 80), value: value.slice(0, 120) });
    if (rows.length >= 12) break;
  }
  return rows;
}

function parsePrimaryUsageWindows(text: string): Array<{ label: string; value: string }> | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  const rows: Array<{ label: string; value: string }> = [];
  // Current layout: "Weekly limit Resets in 6d 6h 83% left". The 5-hour card
  // is not always rendered. Normalize "left" to "remaining" — the client gauge
  // reads a bare percent as *used*.
  for (const [re, label] of [
    [/\b5[- ]hour limit\s+Resets?\s+(.+?)\s+(\d{1,3})%\s*left\b/i, '5 hour usage limit'],
    [/\bWeekly limit\s+Resets?\s+(.+?)\s+(\d{1,3})%\s*left\b/i, 'weekly usage limit'],
  ] as const) {
    const m = flat.match(re);
    if (m) rows.push({ label, value: `${m[2]}% remaining · Resets ${m[1].trim()}` });
  }
  if (rows.length > 0) return rows;
  const session = flat.match(/\b5 hour usage limit\s+(\d{1,3}%\s*remaining)\s+Resets?\s+(.+?)(?=\s+Weekly usage limit\b)/i);
  const weekly = flat.match(/\bWeekly usage limit\s+(\d{1,3}%\s*remaining)\s+Resets?\s+(.+?)(?=\s+GPT-|Credits remaining|Usage breakdown|$)/i);
  if (session) rows.push({ label: '5 hour usage limit', value: `${session[1]} · Resets ${session[2].trim()}` });
  if (weekly) rows.push({ label: 'weekly usage limit', value: `${weekly[1]} · Resets ${weekly[2].trim()}` });
  return rows.length > 0 ? rows : null;
}

function rowsFromCards(cards: Array<{ label: string; percent?: string; reset?: string; value?: string; text: string }>): Array<{ label: string; value: string }> {
  const byLabel = new Map<string, string>();
  for (const card of cards) {
    const label = cleanupLabel(card.label);
    if (!isPrimaryUsageLabel(label)) continue;
    // Ignore broad parent containers. The real card text is short; parent
    // grid wrappers include Spark/credits rows and make the popup noisy.
    if (/spark|credits|balance/i.test(card.text)) continue;
    const valueParts = [card.percent, card.value, card.reset].filter(Boolean) as string[];
    if (!label || valueParts.length === 0) continue;
    const value = valueParts.join(' · ');
    const existing = byLabel.get(label);
    if (!existing || value.length < existing.length) byLabel.set(label, value);
  }
  return ['5 hour usage limit', 'weekly usage limit']
    .flatMap((label) => {
      const value = byLabel.get(label);
      return value ? [{ label, value }] : [];
    });
}

function cleanupLabel(label: string): string {
  return label
    .replace(/\b\d{1,3}%\s*remaining\b/gi, '')
    .replace(/\bResets?.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

function isPrimaryUsageLabel(label: string): boolean {
  const lc = label.toLowerCase();
  if (lc.includes('spark') || lc.includes('credits') || lc.includes('balance')) return false;
  return lc === '5 hour usage limit' || lc === 'weekly usage limit';
}

function parseAdjacentRows(lines: string[]): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const seen = new Set<string>();
  const isValue = (line: string) => (
    /\b\d{1,3}%\b/.test(line) ||
    /\b\d+(?:\.\d+)?\s*(?:k|m)?\s*(?:\/|of)\s*\d+(?:\.\d+)?\s*(?:k|m)?\b/i.test(line) ||
    /\b\d+(?:\.\d+)?\s*(?:tokens|requests|messages|minutes|hours|days)\b/i.test(line) ||
    /\b(?:resets?|renews?)\b/i.test(line)
  );
  const isLabel = (line: string) => /codex|exec|cloud|usage|limit|remaining|used|included|additional|reset/i.test(line);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inlinePct = line.match(/^(.{2,80}?)\s+(\d{1,3}%)$/);
    if (inlinePct) {
      const key = `${inlinePct[1]}:${inlinePct[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        rows.push({ label: inlinePct[1], value: inlinePct[2] });
      }
      continue;
    }
    if (!isLabel(line) || !isPrimaryUsageLabel(cleanupLabel(line))) continue;
    const values: string[] = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
      if (isValue(lines[j])) values.push(lines[j]);
    }
    if (values.length === 0) continue;
    const value = values.join(' · ');
    const key = `${line}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ label: line.slice(0, 80), value: value.slice(0, 140) });
    if (rows.length >= 12) break;
  }
  return rows;
}

function summarizeRows(rows: Array<{ label: string; value: string }>): string | undefined {
  const exec = rows.find((r) => /exec/i.test(r.label));
  const cloud = rows.find((r) => /cloud/i.test(r.label));
  const session = rows.find((r) => /5 hour/i.test(r.label));
  const weekly = rows.find((r) => /weekly/i.test(r.label));
  if (session && weekly) return `${session.value} · weekly ${weekly.value}`;
  if (weekly && !exec && !cloud) return `weekly ${weekly.value}`;
  if (exec && cloud) return `Exec ${exec.value} · Cloud ${cloud.value}`;
  if (exec) return `Exec ${exec.value}`;
  return rows[0] ? `${rows[0].label}: ${rows[0].value}` : undefined;
}

function scrapeScript(): string {
  return [
    'import json, sys',
    'from camoufox.sync_api import Camoufox',
    'profile, url = sys.argv[1], sys.argv[2]',
    'try:',
    '    with Camoufox(headless=True, persistent_context=True, user_data_dir=profile) as ctx:',
    '        page = ctx.new_page()',
    '        page.goto(url, wait_until="domcontentloaded", timeout=30000)',
    '        page.wait_for_timeout(7000)',
    '        text = page.inner_text("body", timeout=10000)',
    '        cards = page.evaluate("""() => {',
    '          const norm = (s) => (s || "").replace(/\\\\s+/g, " ").trim();',
    '          const nodes = [...document.querySelectorAll("div, section, article")];',
    '          return nodes.map((el) => {',
    '            const text = norm(el.innerText);',
    '            if (!text || !/(usage limit|credits remaining)/i.test(text)) return null;',
    '            if (text.length > 350) return null;',
    '            const label = norm(text.split(/\\\\d{1,3}%\\\\s*remaining|\\\\n|Resets/i)[0]) || norm(text.split(/\\\\d/)[0]);',
    '            const percent = (text.match(/\\\\b\\\\d{1,3}%\\\\s*remaining\\\\b/i) || [])[0];',
    '            const reset = (text.match(/Resets?[^\\\\n]*(?:AM|PM|\\\\d{4})?/i) || [])[0];',
    '            const value = /credits remaining/i.test(text) ? (text.match(/Credits remaining\\\\s*(\\\\d+)/i) || [])[1] : undefined;',
    '            return { label, percent, reset, value, text };',
    '          }).filter(Boolean);',
    '        }""")',
    '        print(json.dumps({"ok": True, "title": page.title(), "url": page.url, "text": text, "cards": cards}))',
    'except Exception as e:',
    '    print(json.dumps({"ok": False, "error": str(e)}))',
  ].join('\n');
}

function loginScript(): string {
  return [
    'import sys, time',
    'from camoufox.sync_api import Camoufox',
    'profile, url = sys.argv[1], sys.argv[2]',
    'with Camoufox(headless=False, persistent_context=True, user_data_dir=profile) as ctx:',
    '    page = ctx.new_page()',
    '    page.goto(url, wait_until="domcontentloaded", timeout=60000)',
    '    time.sleep(600)',
  ].join('\n');
}
