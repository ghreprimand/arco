// docs/ARCHITECTURE.md - Support bundle endpoint + redaction smoke.
//
// Two halves:
//   1. Unit-tests the redaction helpers directly (imported from the server
//      module, like cookbook-fit.ts imports fit.ts) on CRAFTED strings carrying
//      a fake home path + fake tokens — proves redactPaths + scrubSecrets work
//      regardless of a live server.
//   2. Hits the LIVE GET /api/diagnostics/support-bundle (director runs this
//      against `npm run dev`): asserts 200, the allowlisted fields, the embedded
//      diagnostics report, and REDACTION — no `/home/<user>` absolute home path
//      and no known secret pattern survives in the copied text.
//
// Run: npm run smoke:support-bundle  (the live half needs the dev server on :3001)

import { step, assert, assertEq, summary } from './lib.js';
import { redactPaths, scrubSecrets } from '../../server/src/diagnostics/supportBundle.js';
import type { SupportBundleResponse } from '../../shared/src/protocol/opsDiagnostics.js';

const HTTP_BASE = process.env.ARCO_SMOKE_HTTP_BASE || 'http://localhost:3001';

// Secret shapes the bundle must never contain. Mirror the builder's patterns;
// the smoke is the independent assertion that the scrub holds.
const SECRET_PROBES: Array<{ name: string; sample: string }> = [
  { name: 'github-token', sample: 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2' },
  { name: 'openai-key', sample: 'sk-proj-' + 'AbC123dEf456GhI789jkL012' },
  { name: 'anthropic-key', sample: 'sk-ant-' + 'api03AbC123dEf456GhI789' },
  { name: 'bearer', sample: 'Bearer abcDEF123456ghiJKL' },
  { name: 'jwt', sample: 'eyJhbGciOiJ.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4' },
];

async function main() {
  // ── unit: redactPaths ──
  await step('redactPaths: collapses the home dir to ~', () => {
    const home = process.env.HOME || '/home/nobody';
    const out = redactPaths(`wrote ${home}/.arco but readback mismatched`);
    assert(!out.includes(home), `home dir must not survive (got: ${out})`);
    assert(out.includes('~/.arco') || out.includes('~'), `home should collapse to ~ (got: ${out})`);
  });

  await step('redactPaths: reduces a non-home absolute path to a basename placeholder', () => {
    const out = redactPaths('opened /srv/secret-project/src/events.jsonl');
    assert(!out.includes('/srv/secret-project'), `private path must not survive (got: ${out})`);
    assert(out.includes('events.jsonl'), `basename should remain useful (got: ${out})`);
  });

  // ── unit: scrubSecrets ──
  await step('scrubSecrets: replaces every known secret shape with <redacted>', () => {
    for (const { name, sample } of SECRET_PROBES) {
      const crafted = `detail with a ${name}: ${sample} embedded`;
      const out = scrubSecrets(crafted);
      assert(!out.includes(sample), `${name} sample must be scrubbed (got: ${out})`);
      assert(out.includes('<redacted>'), `${name} should leave a <redacted> marker (got: ${out})`);
    }
  });

  await step('scrubSecrets: a short git rev (7 hex) is NOT mistaken for a secret', () => {
    const out = scrubSecrets('arco: v0.1.0 (9ed6aef)');
    assert(out.includes('9ed6aef'), `short rev must survive (got: ${out})`);
  });

  // ── live: endpoint ──
  let body: SupportBundleResponse;

  await step('GET /api/diagnostics/support-bundle returns 200 with { json, text }', async () => {
    const r = await fetch(`${HTTP_BASE}/api/diagnostics/support-bundle`);
    assertEq(r.status, 200, 'status 200');
    body = (await r.json()) as SupportBundleResponse;
    assert(body && typeof body === 'object', 'response is an object');
    assert(typeof body.text === 'string' && body.text.length > 0, 'text is a non-empty string');
    assert(body.json && typeof body.json === 'object', 'json is an object');
  });

  await step('bundle.json carries the allowlisted fields + the diagnostics report', () => {
    const j = body.json;
    assert(typeof j.generatedAt === 'number', 'generatedAt is a number');
    assert(typeof j.arcoVersion === 'string', 'arcoVersion is a string');
    assert(typeof j.gitRev === 'string', 'gitRev is a string');
    assert(typeof j.platform === 'string' && j.platform.includes('/'), 'platform looks like os/arch');
    assert(j.runtime && typeof j.runtime.node === 'string', 'runtime.node present');
    assert(typeof j.runtime.serviceMode === 'string', 'runtime.serviceMode present');
    assert(j.diagnostics && Array.isArray(j.diagnostics.groups), 'diagnostics.groups is an array');
    assert(j.diagnostics.groups.length >= 5, 'diagnostics has the five groups');
  });

  await step('redaction: no absolute home path survives in the text', () => {
    // Match a real /home/<user>/ or /Users/<user>/ absolute home prefix. These
    // must have been collapsed to ~ by redactPaths.
    const homeLeak = /\/(?:home|Users)\/[A-Za-z0-9._-]+\//;
    assert(!homeLeak.test(body.text), `an absolute home path leaked into the text: ${body.text.slice(0, 400)}`);
    // Same for the embedded JSON, serialized.
    const jsonText = JSON.stringify(body.json);
    assert(!homeLeak.test(jsonText), 'an absolute home path leaked into the json');
  });

  await step('redaction: no known secret pattern survives in the text or json', () => {
    const jsonText = JSON.stringify(body.json);
    for (const target of [body.text, jsonText]) {
      // Reuse the scrub: a fully-scrubbed bundle is a fixed point — running the
      // scrub again must change nothing. If anything changed, a secret survived.
      assertEq(scrubSecrets(target), target, 'scrub is a fixed point (no secret survived)');
    }
  });

  await step('redaction: injecting a fake token through the scrub still removes it', () => {
    // Defense-in-depth proof independent of the live bundle: the same scrub the
    // builder runs catches a token embedded in arbitrary text.
    const poisoned = `${body.text}\nleaked: ghp_${'Z9y8X7w6V5u4T3s2R1q0P9o8'}`;
    const cleaned = scrubSecrets(poisoned);
    assert(!/ghp_[A-Za-z0-9]{20,}/.test(cleaned), 'injected GitHub token must be scrubbed');
  });

  summary('support-bundle');
}

main();
