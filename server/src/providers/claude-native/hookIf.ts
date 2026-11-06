// The `if` field of a hook handler, as in Claude Code: one permission rule
// such as "Bash(git *)", "Edit(*.ts)" or "WebFetch(domain:example.com)". The
// handler runs only when the tool call matches. Only tool events read it; on
// every other event a handler with `if` set never runs.
//
// Like Claude Code's own check it is best-effort and errs towards running the
// hook: a shell command it cannot take apart, or a rule it cannot read, lets
// the hook run.
import { homedir } from 'node:os';
import path from 'node:path';

export const IF_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);

export interface IfCall {
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Where relative paths in the call and plain rule paths resolve. */
  cwd: string;
  /** Where a rule path with one leading "/" is anchored (the settings file's project, or ~/.claude for user settings). */
  anchorDir: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export function parseRule(rule: string): { tool: string; spec?: string } | null {
  const t = rule.trim();
  if (!t) return null;
  const open = t.indexOf('(');
  if (open < 0) return { tool: t };
  if (!t.endsWith(')') || open === 0) return null;
  return { tool: t.slice(0, open).trim(), spec: t.slice(open + 1, -1) };
}

// Edit rules cover every tool that edits a file, Read rules every tool that
// reads one. A path rule written for another tool name never matches.
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const PATH_ONLY_BY_NAME = new Set(['Write', 'MultiEdit', 'NotebookEdit', 'Glob']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// Claude Code names its subagent tool Agent; Arco's is Task.
const TOOL_ALIASES: Record<string, string> = { Agent: 'Task' };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toolNameMatches(ruleTool: string, toolName: string): boolean {
  const rt = TOOL_ALIASES[ruleTool] ?? ruleTool;
  if (rt === toolName) return true;
  if (rt.includes('*')) return new RegExp(`^${rt.split('*').map(escapeRe).join('.*')}$`).test(toolName);
  // "mcp__server" covers every tool of that server.
  if (/^mcp__/.test(rt) && rt.indexOf('__', 5) < 0) return toolName.startsWith(`${rt}__`);
  return false;
}

export function ifMatches(rule: string, call: IfCall): boolean {
  const parsed = parseRule(rule);
  // A rule that cannot be read: run the hook rather than silently drop it.
  if (!parsed) return true;
  const { tool, spec } = parsed;
  const s = spec?.trim();
  if (s !== undefined && s !== '' && s !== '*') {
    if (tool === 'Edit' || tool === 'Read') {
      if (!(tool === 'Edit' ? EDIT_TOOLS : READ_TOOLS).includes(call.toolName)) return false;
      const target = filePathOf(call);
      return target === null ? true : pathRuleMatches(s, target, call);
    }
    if (PATH_ONLY_BY_NAME.has(tool)) return false;
  }
  if (!toolNameMatches(tool, call.toolName)) return false;
  if (s === undefined || s === '' || s === '*') return true;
  if (SHELL_TOOLS.has(call.toolName)) {
    const command = call.toolInput.command;
    return typeof command === 'string' ? shellRuleMatches(s, command, call.toolName === 'PowerShell') : true;
  }
  if (call.toolName === 'WebFetch' && /^domain\s*:/.test(s)) {
    const url = call.toolInput.url;
    try { return typeof url === 'string' ? domainMatches(s.replace(/^domain\s*:\s*/, ''), new URL(url).hostname) : true; } catch { return true; }
  }
  if (call.toolName === 'Task' && !/^\w+\s*:/.test(s)) {
    const type = typeof call.toolInput.subagent_type === 'string' && call.toolInput.subagent_type ? call.toolInput.subagent_type : 'general-purpose';
    return type === s;
  }
  const param = /^(\w+)\s*:\s*(.*)$/s.exec(s);
  if (param) {
    const value = call.toolInput[param[1]];
    if (value === undefined || value === null || typeof value === 'object') return false;
    return new RegExp(`^${param[2].split('*').map(escapeRe).join('.*')}$`, 's').test(String(value));
  }
  // A specifier this tool has no syntax for: the hook runs.
  return true;
}

// ── Shell commands ──────────────────────────────────────────────────────────

// Each subcommand of the input is checked on its own; commands inside $()
// and backticks are subcommands too. A pattern that names more than the
// program runs the hook anyway when the command has $(), backticks or $VAR,
// and so does a command that cannot be taken apart.
export function shellRuleMatches(pattern: string, command: string, powershell: boolean): boolean {
  let p = pattern.trim();
  if (p.endsWith(':*')) p = `${p.slice(0, -2)} *`;
  const parsed = powershell ? splitPowerShell(command) : splitShell(command);
  if (!parsed) return true;
  const nameOnly = /^[^\s*]+(?:\s*\*)?$/.test(p);
  if (!nameOnly && parsed.dynamic) return true;
  const re = wildcardRegex(powershell ? canonicalPowerShell(p) : p, powershell);
  return parsed.subcommands.some((sub) => {
    const normal = powershell ? canonicalPowerShell(sub) : stripShellPrefixes(sub);
    return normal !== '' && re.test(normal);
  });
}

function wildcardRegex(pattern: string, ignoreCase: boolean): RegExp {
  const stars = pattern.split('*').length - 1;
  // "ls *" also matches a bare "ls" when that trailing * is the only one.
  if (stars === 1 && /\s\*$/.test(pattern)) {
    return new RegExp(`^${escapeRe(pattern.slice(0, -1).trimEnd())}(?:\\s.*)?$`, ignoreCase ? 'is' : 's');
  }
  return new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`, ignoreCase ? 'is' : 's');
}

const WRAPPERS = new Set(['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '(', 'fi', 'done', '}', ')', 'time']);

// Leading VAR=value assignments, wrappers (timeout 30, nice -n 5, nohup ...),
// bare xargs and control-flow keywords come off; whitespace is collapsed.
export function stripShellPrefixes(sub: string): string {
  let words = shellWords(sub);
  for (let guard = 0; guard < 20 && words.length > 0; guard++) {
    const w = words[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { words = words.slice(1); continue; }
    if (KEYWORDS.has(w)) { words = words.slice(1); continue; }
    if (w === 'xargs' && words[1] && !words[1].startsWith('-')) { words = words.slice(1); continue; }
    if (WRAPPERS.has(w) && !(w === 'command' && /^-[vV]$/.test(words[1] ?? ''))) {
      let i = 1;
      while (i < words.length && words[i].startsWith('-')) {
        // Options that take a value: timeout -s SIG / -k DUR, nice -n N.
        i += (w === 'timeout' && /^-[sk]$/.test(words[i])) || (w === 'nice' && words[i] === '-n') ? 2 : 1;
      }
      if (w === 'timeout' && i < words.length && /^\d/.test(words[i])) i += 1;
      words = words.slice(i);
      continue;
    }
    break;
  }
  while (words.length > 0 && KEYWORDS.has(words[words.length - 1])) words = words.slice(0, -1);
  return words.join(' ');
}

// Whitespace-separated words, keeping quoted text (FOO="a b") in one word.
function shellWords(text: string): string[] {
  const words: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { cur += c; if (c === '\\' && q === '"') { cur += text[i + 1] ?? ''; i++; } else if (c === q) q = null; continue; }
    if (c === '\\') { cur += c + (text[i + 1] ?? ''); i++; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (/\s/.test(c)) { if (cur) words.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur) words.push(cur);
  return words;
}

export interface SplitCommand { subcommands: string[]; dynamic: boolean }

// Splits on && || ; | |& & and newlines outside quotes; $(...), `...` and
// <(...) bodies are split as well. Null when the input cannot be taken apart
// (an unclosed quote or substitution, a here-document, an operator with
// nothing after it).
export function splitShell(command: string): SplitCommand | null {
  const subs: string[] = [];
  let dynamic = false;
  const walk = (text: string, depth: number): boolean => {
    if (depth > 8) return false;
    let cur = '';
    let i = 0;
    const push = (): void => { const t = cur.trim(); if (t) subs.push(t); cur = ''; };
    let lastOp = false;
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') { cur += text.slice(i, i + 2); i += 2; continue; }
      if (c === "'") {
        const end = text.indexOf("'", i + 1);
        if (end < 0) return false;
        cur += text.slice(i, end + 1); i = end + 1; lastOp = false; continue;
      }
      if (c === '"') {
        let j = i + 1;
        let inner = '';
        while (j < text.length && text[j] !== '"') {
          if (text[j] === '\\') { inner += text.slice(j, j + 2); j += 2; continue; }
          if (text[j] === '$' && text[j + 1] === '(') {
            const end = matchParen(text, j + 1);
            if (end < 0) return false;
            dynamic = true;
            if (!walk(text.slice(j + 2, end), depth + 1)) return false;
            inner += text.slice(j, end + 1); j = end + 1; continue;
          }
          if (text[j] === '`') {
            const end = text.indexOf('`', j + 1);
            if (end < 0) return false;
            dynamic = true;
            if (!walk(text.slice(j + 1, end), depth + 1)) return false;
            inner += text.slice(j, end + 1); j = end + 1; continue;
          }
          if (text[j] === '$' && /[A-Za-z_{]/.test(text[j + 1] ?? '')) dynamic = true;
          inner += text[j]; j++;
        }
        if (j >= text.length) return false;
        cur += `"${inner}"`; i = j + 1; lastOp = false; continue;
      }
      if ((c === '$' || c === '<' || c === '>') && text[i + 1] === '(') {
        const end = matchParen(text, i + 1);
        if (end < 0) return false;
        dynamic = true;
        if (!walk(text.slice(i + 2, end), depth + 1)) return false;
        cur += text.slice(i, end + 1); i = end + 1; lastOp = false; continue;
      }
      if (c === '`') {
        const end = text.indexOf('`', i + 1);
        if (end < 0) return false;
        dynamic = true;
        if (!walk(text.slice(i + 1, end), depth + 1)) return false;
        cur += text.slice(i, end + 1); i = end + 1; lastOp = false; continue;
      }
      if (c === '$' && /[A-Za-z_{0-9@*#?$!-]/.test(text[i + 1] ?? '')) dynamic = true;
      if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<') return false; // here-document
      // Redirections such as 2>&1, &> and >& are not separators.
      if (c === '&' && (text[i + 1] === '>' || text[i - 1] === '>' || text[i - 1] === '<')) { cur += c; i++; continue; }
      if (c === '|' && text[i - 1] === '>') { cur += c; i++; continue; }
      const two = text.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === '|&' || two === ';;') {
        if (!cur.trim() && !subs.length && depth === 0) return false;
        push(); i += 2; lastOp = true; continue;
      }
      if (c === ';' || c === '|' || c === '&' || c === '\n') {
        push(); i += 1; lastOp = c !== '\n' && c !== ';' && c !== '&'; continue;
      }
      if ((c === '(' || c === ')' || c === '{' || c === '}') && !cur.trim()) { i++; continue; }
      if (c === ')' || c === '}') { push(); i++; continue; }
      cur += c; i++;
      if (c.trim()) lastOp = false;
    }
    if (lastOp) return false;
    push();
    return true;
  };
  // A backslash at the end of a line continues the command.
  return walk(command.replace(/\\\r?\n/g, ' '), 0) ? { subcommands: subs, dynamic } : null;
}

function matchParen(text: string, open: number): number {
  let depth = 0;
  let q: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '\\' && q === '"') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// PowerShell: ; | && || and newlines split; $( ) bodies too; cmdlet aliases
// become the cmdlet name; matching ignores case.
export function splitPowerShell(command: string): SplitCommand | null {
  const subs: string[] = [];
  let dynamic = false;
  const walk = (text: string, depth: number): boolean => {
    if (depth > 8) return false;
    let cur = '';
    const push = (): void => { const t = cur.trim(); if (t) subs.push(t); cur = ''; };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '`') { cur += text.slice(i, i + 2); i++; continue; }
      if (c === "'") { const end = text.indexOf("'", i + 1); if (end < 0) return false; cur += text.slice(i, end + 1); i = end; continue; }
      if (c === '"') {
        let j = i + 1;
        while (j < text.length && text[j] !== '"') { if (text[j] === '`') j++; else if (text[j] === '$') dynamic = true; j++; }
        if (j >= text.length) return false;
        cur += text.slice(i, j + 1); i = j; continue;
      }
      if (c === '$' && text[i + 1] === '(') {
        const end = matchParen(text, i + 1);
        if (end < 0) return false;
        dynamic = true;
        if (!walk(text.slice(i + 2, end), depth + 1)) return false;
        cur += text.slice(i, end + 1); i = end; continue;
      }
      if (c === '$') dynamic = true;
      const two = text.slice(i, i + 2);
      if (two === '&&' || two === '||') { push(); i++; continue; }
      if (c === ';' || c === '|' || c === '\n') { push(); continue; }
      cur += c;
    }
    push();
    return true;
  };
  return walk(command, 0) ? { subcommands: subs, dynamic } : null;
}

const PS_ALIASES: Record<string, string> = {
  gci: 'Get-ChildItem', ls: 'Get-ChildItem', dir: 'Get-ChildItem',
  rm: 'Remove-Item', del: 'Remove-Item', erase: 'Remove-Item', rd: 'Remove-Item', rmdir: 'Remove-Item', ri: 'Remove-Item',
  cp: 'Copy-Item', copy: 'Copy-Item', cpi: 'Copy-Item',
  mv: 'Move-Item', move: 'Move-Item', mi: 'Move-Item',
  cat: 'Get-Content', gc: 'Get-Content', type: 'Get-Content',
  echo: 'Write-Output', write: 'Write-Output',
  cd: 'Set-Location', chdir: 'Set-Location', sl: 'Set-Location',
  pwd: 'Get-Location', gl: 'Get-Location',
  ni: 'New-Item', sc: 'Set-Content', ac: 'Add-Content',
  iwr: 'Invoke-WebRequest', curl: 'Invoke-WebRequest', wget: 'Invoke-WebRequest', irm: 'Invoke-RestMethod',
  ps: 'Get-Process', gps: 'Get-Process', kill: 'Stop-Process', spps: 'Stop-Process',
  iex: 'Invoke-Expression', sleep: 'Start-Sleep', cls: 'Clear-Host', clear: 'Clear-Host',
  '?': 'Where-Object', where: 'Where-Object', '%': 'ForEach-Object', foreach: 'ForEach-Object',
  select: 'Select-Object', sort: 'Sort-Object', saps: 'Start-Process', start: 'Start-Process',
};

function canonicalPowerShell(sub: string): string {
  const words = sub.trim().replace(/^&\s+/, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const alias = PS_ALIASES[words[0].toLowerCase()];
  if (alias) words[0] = alias;
  return words.join(' ');
}

// ── File paths ──────────────────────────────────────────────────────────────

function filePathOf(call: IfCall): string | null {
  const i = call.toolInput;
  const raw = typeof i.file_path === 'string' ? i.file_path
    : typeof i.notebook_path === 'string' ? i.notebook_path
      : typeof i.path === 'string' ? i.path
        : READ_TOOLS.includes(call.toolName) ? call.cwd : null;
  if (raw === null || raw === '') return raw === '' ? call.cwd : null;
  const win = (call.platform ?? process.platform) === 'win32';
  const abs = win ? path.win32.resolve(call.cwd, raw) : path.posix.resolve(call.cwd, raw);
  return abs;
}

// Absolute path in POSIX form: C:\Users\x becomes /c/Users/x on Windows.
export function posixPath(p: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return p;
  const drive = /^([A-Za-z]):[\\/]?/.exec(p);
  const rest = p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/');
  return drive ? `/${drive[1].toLowerCase()}${rest.startsWith('/') ? rest : `/${rest}`}` : rest;
}

// gitignore pattern syntax: * within one segment, ** across segments, ?
// one character, [...] a class; a match also covers everything below it.
export function globRegex(pattern: string, ignoreCase: boolean): RegExp {
  let re = '';
  let i = 0;
  const p = pattern.replace(/\/+$/, '');
  while (i < p.length) {
    if (p.startsWith('**/', i)) { re += '(?:.*/)?'; i += 3; continue; }
    if (p.startsWith('/**', i) && i + 3 === p.length) { re += '(?:/.*)?'; i += 3; continue; }
    if (p.startsWith('**', i)) { re += '.*'; i += 2; continue; }
    const c = p[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = p.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else { re += `[${p.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = end; }
    } else re += escapeRe(c);
    i++;
  }
  return new RegExp(`^${re}(?:/.*)?$`, ignoreCase ? 'i' : '');
}

export function pathRuleMatches(spec: string, targetAbs: string, call: IfCall): boolean {
  if (spec.startsWith('!')) return false;
  const platform = call.platform ?? process.platform;
  const win = platform === 'win32';
  const home = call.homeDir ?? homedir();
  let anchor: string;
  let pat: string;
  let anyDepth = false;
  if (spec.startsWith('//')) { anchor = '/'; pat = spec.slice(2); }
  else if (spec.startsWith('~/')) { anchor = posixPath(home, platform); pat = spec.slice(2); }
  else if (spec.startsWith('/')) { anchor = posixPath(call.anchorDir, platform); pat = spec.slice(1); }
  else {
    anchor = posixPath(call.cwd, platform);
    pat = spec.replace(/^\.\//, '');
    // A bare file name or pattern matches at any depth, as in gitignore.
    anyDepth = !pat.replace(/\/+$/, '').includes('/');
  }
  const target = posixPath(targetAbs, platform);
  const a = anchor.replace(/\/+$/, '');
  const norm = (s: string): string => (win ? s.toLowerCase() : s);
  let rel: string;
  if (a === '') rel = target.replace(/^\/+/, '');
  else if (norm(target) === norm(a)) rel = '';
  else if (norm(target).startsWith(`${norm(a)}/`)) rel = target.slice(a.length + 1);
  else return false;
  return globRegex(anyDepth ? `**/${pat}` : pat, win).test(rel);
}

// ── Web domains ─────────────────────────────────────────────────────────────

export function domainMatches(rule: string, hostname: string): boolean {
  const r = rule.trim().toLowerCase().replace(/\.$/, '');
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (r === '*') return true;
  if (r.startsWith('*.')) return h.endsWith(r.slice(1)) && h.length > r.length - 1;
  return new RegExp(`^${r.split('*').map(escapeRe).join('[^.]*')}$`).test(h);
}
