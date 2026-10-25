// Deterministic CLI interpreter peer: no inference or credentials.
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
if (!args.includes('exec')) {
  console.log(args.includes('--version') ? 'codex-cli 0.162.1' : 'Logged in using ChatGPT');
  process.exit(0);
}
for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--output-schema']) assert(args.includes(flag));
assert(args.includes('gpt-6-luna')); assert(args.includes('model_reasoning_effort="low"'));
assert(args.includes('project_doc_max_bytes=0')); assert.equal(process.env.OPENAI_API_KEY, undefined);
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
assert.equal(request.utterance, 'Bring up my reviewer');
assert.equal(request.targets[0].name, 'Reviewer');
const out = (value) => console.log(JSON.stringify(value));
out({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ action: 'navigate', target: 'Reviewer', value: '' }) } });
out({ type: 'turn.completed', usage: { input_tokens: 200, cached_input_tokens: 100, output_tokens: 20 } });
