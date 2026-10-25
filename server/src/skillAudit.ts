// H35 — operator-triggered skill security audit. A skill's SKILL.md body is
// folded into the model's context, so a hostile or careless skill is a prompt-
// injection / supply-chain vector. This is a READ-ONLY, DIAGNOSTIC scan the
// operator runs from the editor: it surfaces invisible-unicode and known
// threat-patterns and reports them. It does NOT gate install — there is
// deliberately NO `should_allow_install` verdict (that server-authoritative
// quality judgment is the border-A pattern). The operator reads the findings and
// decides; nothing is auto-blocked.

export type AuditSeverity = 'info' | 'warn';

export interface AuditFinding {
  severity: AuditSeverity;
  kind: string;
  detail: string;
}

export interface AuditReport {
  findings: AuditFinding[];
}

// Suspicious invisible / formatting code points. These never legitimately appear
// in a hand-written skill and are the classic vehicle for hidden instructions:
//   • zero-width spaces/joiners (U+200B–200D), LRM/RLM (U+200E/F)
//   • bidi overrides (U+202A–202E) — "Trojan Source" style reordering
//   • word-joiner / invisible math operators (U+2060–2064)
//   • deprecated format chars (U+206A–206F)
//   • BOM / zero-width no-break space (U+FEFF), soft hyphen (U+00AD)
//   • Unicode TAG block (U+E0000–U+E007F) — used to smuggle ASCII invisibly
const INVISIBLE_RANGES: Array<{ name: string; re: RegExp }> = [
  { name: 'zero-width / directional marks', re: /[​-‏]/u },
  { name: 'bidirectional override (Trojan Source)', re: /[‪-‮]/u },
  { name: 'word-joiner / invisible operators', re: /[⁠-⁤]/u },
  { name: 'deprecated format characters', re: /[⁪-⁯]/u },
  { name: 'BOM / zero-width no-break space', re: /﻿/u },
  { name: 'soft hyphen', re: /­/u },
  { name: 'Unicode TAG block (hidden ASCII)', re: /[\u{E0000}-\u{E007F}]/u },
];

// Threat-pattern signatures. Each is a coarse, deliberately-conservative regex —
// a hit is a prompt for the operator to LOOK, not proof of malice.
const THREAT_PATTERNS: Array<{ kind: string; re: RegExp; detail: string }> = [
  { kind: 'pipe-to-shell', re: /\b(?:curl|wget|fetch)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/i, detail: 'downloads and pipes a script straight into a shell (curl … | sh)' },
  { kind: 'base64-to-shell', re: /base64\s+(?:-d|--decode)[^\n]*\|\s*(?:ba)?sh\b/i, detail: 'decodes base64 and pipes it into a shell — common obfuscation' },
  { kind: 'prompt-injection', re: /\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|prompts?|messages?)\b/i, detail: 'instructs the model to ignore prior instructions (prompt injection)' },
  { kind: 'role-override', re: /\byou\s+are\s+now\b|\bdisregard\s+(?:your|the)\s+(?:system|previous)\b/i, detail: 'attempts to override the agent\'s role / system prompt' },
  { kind: 'secret-exfiltration', re: /(?:\.aws\/credentials|\.ssh\/id_|process\.env|printenv|secrets?|api[_-]?key|\btoken\b|\bcredentials\b)[^\n]*(?:curl|wget|fetch|https?:|upload|exfil)/i, detail: 'reads secrets/credentials near a network call (possible exfiltration)' },
  { kind: 'recursive-delete', re: /\brm\s+-\w*(?:rf|fr)\w*\s+(?:\/(?:\s|$)|~|\$HOME|\*)/i, detail: 'a catastrophic recursive delete (rm -rf of root/home/glob)' },
  { kind: 'remote-eval', re: /\b(?:eval|exec)\s*\(\s*(?:requests?\.get|urllib|fetch|http)/i, detail: 'evaluates code fetched from the network' },
];

// Run the audit over a skill body. Pure + synchronous — no fs, no model call.
export function auditSkillContent(text: string): AuditReport {
  const findings: AuditFinding[] = [];
  if (!text) return { findings };

  // Invisible-unicode pass — report each distinct category present, with a count.
  for (const { name, re } of INVISIBLE_RANGES) {
    const g = new RegExp(re.source, 'gu');
    const count = (text.match(g) ?? []).length;
    if (count > 0) {
      findings.push({
        severity: 'warn',
        kind: 'invisible-unicode',
        detail: `${count} ${name} character${count === 1 ? '' : 's'} found — invisible text can hide instructions from a human reviewer`,
      });
    }
  }

  // Threat-pattern pass.
  for (const { kind, re, detail } of THREAT_PATTERNS) {
    if (re.test(text)) {
      findings.push({ severity: 'warn', kind, detail });
    }
  }

  if (findings.length === 0) {
    findings.push({ severity: 'info', kind: 'clean', detail: 'No invisible unicode or known threat patterns found. (Diagnostic only — review the body yourself.)' });
  }
  return { findings };
}
