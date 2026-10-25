// One-off probe: spawn `codex app-server`, call model/list, dump what we
// get back. Use to validate the catalog approach before wiring the client.
//
// Run from repo root:
//   cd server && npx tsx scripts/probe-codex-catalog.ts

import { getCodexCatalog } from '../src/providers/codex-appserver/catalog.js';

async function main() {
  console.log('Probing codex app-server model/list...\n');
  const start = Date.now();
  const snap = await getCodexCatalog(true);
  const elapsed = Date.now() - start;
  console.log(`Fetched in ${elapsed}ms (fresh=${snap.fresh}, models=${snap.models.length})\n`);
  if (snap.models.length === 0) {
    console.log('No models returned. Likely causes: not logged in (try `codex login status`),');
    console.log('or app-server hung during initialize. Re-run with stderr visible.');
    process.exit(1);
  }
  for (const m of snap.models) {
    const efforts = m.supportedReasoningEfforts.join(',') || '(none)';
    const speedTiers = m.additionalSpeedTiers.length > 0 ? `[+${m.additionalSpeedTiers.join(',')}]` : '';
    const flags = [
      m.isDefault ? 'default' : '',
      m.hidden ? 'hidden' : '',
      m.supportsImageInput ? 'image' : '',
      m.supportsPersonality ? 'personality' : '',
    ].filter(Boolean).join(',');
    console.log(`${m.id.padEnd(28)}  efforts=[${efforts}] default=${m.defaultReasoningEffort} ${speedTiers} ${flags ? `(${flags})` : ''}`);
    if (m.displayName !== m.id) console.log(`  display: ${m.displayName}`);
    if (m.description) console.log(`  desc:    ${m.description}`);
  }
  console.log('\nDone. Hidden=true entries are unhidden by includeHidden in the probe.');
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exit(1);
});
