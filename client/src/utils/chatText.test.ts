import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPrimaryText } from './chatText.js';

const JSON_BLOCK = '```json\n{\n  "action": "accept",\n  "src": ["autogroup:member"],\n  "dst": ["tag:workstation"]\n}\n```';

test('a closed json block followed by prose renders intact (the stuck "assembling…" bug)', () => {
  const msg = `Add this entry to the "ssh" array:\n\n${JSON_BLOCK}\n\nThen save and retry.`;
  const out = cleanPrimaryText(msg).text;
  assert.ok(!out.includes('assembling'), out);
  assert.ok(out.includes('"dst": ["tag:workstation"]'));
  assert.ok(out.endsWith('Then save and retry.'));
});

test('a closed untagged block starting with { followed by prose renders intact', () => {
  const msg = 'Config:\n\n```\n{ "a": 1 }\n```\n\nDone.';
  assert.equal(cleanPrimaryText(msg).text, msg);
});

test('a trailing json block still streaming is hidden behind the placeholder', () => {
  const msg = 'Add this:\n\n```json\n{\n  "action": "acc';
  const out = cleanPrimaryText(msg).text;
  assert.equal(out, 'Add this:\n\n→ assembling…');
});

test('an unclosed block after a closed one: only the trailing one is hidden', () => {
  const msg = `First:\n\n${JSON_BLOCK}\n\nSecond:\n\n\`\`\`json\n{ "partial": `;
  const out = cleanPrimaryText(msg).text;
  assert.ok(out.includes('"dst": ["tag:workstation"]'));
  assert.ok(out.includes('Second:'));
  assert.ok(out.endsWith('→ assembling…'));
});

test('a streaming non-JSON code block is left visible', () => {
  const msg = 'Run:\n\n```bash\nssh workstation';
  assert.equal(cleanPrimaryText(msg).text, msg);
});

test('ordinary JSON answers keep reserved-looking application keys', () => {
  for (const body of ['{"workers":4,"timeout":30}', '{"stateMutations":{"enabled":true}}', '{"qualityVerdicts":["pass"]}', '{"dispatch":{"mode":"application"}}']) {
    const text = '```json\n' + body + '\n```';
    assert.equal(cleanPrimaryText(text).text, text);
  }
});

test('the hyphenated artifact fence is recognized closed and streaming', () => {
  assert.equal(cleanPrimaryText('```arco-artifact\n{"path":"fixture.md"}\n```').artifacts, 1);
  assert.match(cleanPrimaryText('```arco-artifact\n{"path":').text, /artifact/);
});

test('recognized legacy envelopes still collapse to their summaries', () => {
  const body = JSON.stringify({workers:[{id:'worker',model:'fixture',prompt:'Inspect fixture'}],stateMutations:[{op:'set',path:'fixture'}],qualityVerdicts:[{workerId:'worker',verdict:'pass'}]});
  const result = cleanPrimaryText('```json\n'+body+'\n```');
  assert.equal(result.dispatchedWorkers,1);assert.equal(result.stateMutations,1);assert.equal(result.qualityVerdicts,1);
});
