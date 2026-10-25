// Genesis field-assist smoke.
//
// Pure prompt/parser coverage for the M2/M3 Genesis Ask-AI field assistant.
// No dev server and no live model: the WS handler's side-effect-free helpers
// are exercised directly so the protocol addition has a cheap regression gate.

import { buildGenesisAssistPrompt, parseAssistOutput } from '../../server/src/ws/genesisHandlers.js';
import type { GenesisSeed } from '@archon/shared';

let passes = 0;
let fails = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passes++;
  } else {
    const msg = `${label}${detail ? `: ${detail}` : ''}`;
    console.log(`  FAIL  ${msg}`);
    failures.push(msg);
    fails++;
  }
}

const seed: GenesisSeed = {
  title: 'Atlas-terminal',
  spark: 'A from-scratch terminal coding workbench with strong reliability, themes, color schemes, and useful visual features.',
  concept: 'A terminal-first project workbench for running and comparing coding agents.',
  theCase: 'The operator wants a reliable daily driver with enough visual affordance to stay oriented.',
  buildDirection: 'Start with a TypeScript TUI prototype, define the core workflow loop, then add themes after the model/run substrate is stable.',
  nameWorkbench: {
    shortlisted: ['Lucent'],
    rejected: ['Termina'],
  },
};

{
  const prompt = buildGenesisAssistPrompt(seed, 'concept', 'fresh');
  check('concept prompt names target field', /Target field: Concept/.test(prompt));
  check('concept prompt includes seed spark', prompt.includes(seed.spark));
  check('concept prompt forbids unsupported invention', /Never invent audiences/.test(prompt));
  check('fresh prompt ignores current field', /Ignore the current field value/.test(prompt));
  check('prompt requires JSON object', /"suggestion"/.test(prompt) && /"rationale"/.test(prompt));
}

{
  const prompt = buildGenesisAssistPrompt(seed, 'stack', 'stack', 'Prefer a language with strong TUI libraries.');
  check('stack prompt names target field', /Target field: Stack/.test(prompt));
  check('stack prompt includes refinement', /Prefer a language/.test(prompt));
  check('stack prompt asks for tradeoffs', /tradeoffs/i.test(prompt));
}

{
  const prompt = buildGenesisAssistPrompt(seed, 'title', 'name');
  check('name prompt uses full seed', /full seed/i.test(prompt) && /Build-direction:/.test(prompt) && prompt.includes(seed.buildDirection));
  check('name prompt asks for multiple options', /6-10 distinct name options/.test(prompt));
  check('name prompt carries shortlist', /Shortlisted names: Lucent/.test(prompt));
  check('name prompt carries rejected names', /Rejected names: Termina/.test(prompt));
}

{
  const parsed = parseAssistOutput('{"suggestion":"Node + TypeScript with Ink for the first TUI slice.","rationale":"Matches the stated reliability and theme needs."}');
  check('parse JSON suggestion', parsed.suggestion.startsWith('Node + TypeScript'));
  check('parse JSON rationale', parsed.rationale === 'Matches the stated reliability and theme needs.');
}

{
  const parsed = parseAssistOutput('```json\n{"suggestion":"Atlas Console","rationale":"Short and tied to the working name."}\n```');
  check('parse fenced JSON suggestion', parsed.suggestion === 'Atlas Console');
  check('parse fenced JSON rationale', parsed.rationale === 'Short and tied to the working name.');
}

{
  const parsed = parseAssistOutput('{"options":[{"name":"Lucent","rationale":"Clear and visual."},{"name":"Prism Shell","rationale":"Evokes color without overpromising."}],"rationale":"Both fit the visual-terminal direction."}');
  check('parse name options first suggestion', parsed.suggestion === 'Lucent');
  check('parse name options length', parsed.options?.length === 2);
  check('parse name option rationale', parsed.options?.[1]?.rationale === 'Evokes color without overpromising.');
}

{
  const parsed = parseAssistOutput('A compact local-first terminal workbench for shaping, running, and reviewing coding-agent turns.');
  check('plain text fallback returns suggestion', parsed.suggestion.startsWith('A compact local-first'));
}

console.log(`\n${fails === 0 ? 'OK' : 'FAIL'} — ${passes} passed, ${fails} failed`);
if (fails > 0) {
  console.log('Failures:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
