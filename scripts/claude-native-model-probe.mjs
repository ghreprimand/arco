#!/usr/bin/env node
// Bulk-probe candidate Claude model IDs against the live Anthropic API
// using Arco's Claude Native auth. Hits the dev server's
// /api/auth/claude-native/probe endpoint, which forwards a tiny
// messages.create round-trip with the standard Claude Code wire
// fingerprint. Use this to discover which model IDs are actually
// addressable from your subscription, what the API echoes back, and
// how beta headers (e.g. context-1m-*) behave per model.
//
// Usage:
//   node scripts/claude-native-model-probe.mjs           # default candidates
//   node scripts/claude-native-model-probe.mjs <ids...>  # specific IDs
//   PROBE_BETA="context-1m-2024-08-21" node scripts/claude-native-model-probe.mjs claude-opus-4-7
//
// Pre-req: dev server running (npm run dev:server) and Native auth set up.

const HOST = process.env.PROBE_HOST || 'http://127.0.0.1:3001';
const EXTRA_BETA = process.env.PROBE_BETA ? process.env.PROBE_BETA.split(',').map((s) => s.trim()).filter(Boolean) : [];

// Curated candidate list — drawn from the picker entries in the Claude
// Code CLI plus older / addressable IDs Anthropic has shipped over the
// past ~2 years. Edit freely; pass IDs on argv to override.
const DEFAULT_CANDIDATES = [
  // Adaptive-thinking (current daily-driver tier)
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  // Family aliases — should resolve to the latest
  'opus',
  'sonnet',
  'haiku',
  // 4.x older (budget-thinking)
  'claude-sonnet-4-5',
  'claude-sonnet-4',
  'claude-opus-4-1',
  'claude-opus-4',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  // 3.7
  'claude-3-7-sonnet-20250219',
  'claude-3-7-sonnet-latest',
  // 3.5
  'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-20240620',
  'claude-3-5-haiku-20241022',
  'claude-3-5-haiku-latest',
  // Legacy 3.0
  'claude-3-opus-20240229',
  'claude-3-sonnet-20240229',
  'claude-3-haiku-20240307',
];

const candidates = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_CANDIDATES;

function pad(s, n) { return (s + ' '.repeat(n)).slice(0, n); }

console.log(`probing ${candidates.length} model id(s) against ${HOST}`);
if (EXTRA_BETA.length) console.log(`extra beta headers: ${EXTRA_BETA.join(',')}`);
console.log();
console.log(pad('MODEL ID', 38), pad('STATUS', 8), pad('ECHOED', 32), 'NOTES');
console.log('-'.repeat(120));

for (const model of candidates) {
  try {
    const res = await fetch(`${HOST}/api/auth/claude-native/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, beta: EXTRA_BETA, maxTokens: 16, prompt: 'hi' }),
    });
    const data = await res.json();
    if (data.ok) {
      const note = data.echoedModel && data.echoedModel !== model
        ? `aliased → ${data.echoedModel}`
        : 'ok';
      console.log(pad(model, 38), pad(`${data.status}`, 8), pad(data.echoedModel ?? '—', 32), note);
    } else {
      const note = `${data.errorType ?? 'http_error'}: ${(data.errorMessage ?? '').slice(0, 60)}`;
      console.log(pad(model, 38), pad(`${data.status ?? '—'}`, 8), pad('—', 32), note);
    }
  } catch (err) {
    console.log(pad(model, 38), pad('NET', 8), pad('—', 32), err.message);
  }
}
