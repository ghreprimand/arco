// Opt-in live acceptance: a running Strata + SearXNG and a throwaway Archon.
// ARCHON_SMOKE_WS_URL=ws://localhost:3099/ws npm run smoke:strata-live
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, assert } from './lib.js';

async function main() {
const c = await connect();
const ids: string[] = [];
const artifactDir = process.env.STRATA_SMOKE_ARTIFACTS || mkdtempSync(join(tmpdir(), 'archon-strata-live-'));
const model = process.env.STRATA_SMOKE_MODEL || 'qwen3.8-flash-next-iq3_xxs-262k';
const events: unknown[] = [];
async function create(kind: 'chat' | 'workflow') {
  c.send({ type: 'create_workflow', config: { kind, name: `Strata ${kind} acceptance`, primaryProvider: 'strata', primaryModel: model, primaryEffort: 'none', workingDirectory: kind === 'chat' ? '' : artifactDir, skipPermissions: kind !== 'chat', chatWebAccess: true } });
  const m = await c.waitFor((m) => m.type === 'workflow_created', 10000);
  const id = String(m.workflowId); ids.push(id); return id;
}
async function turn(id: string, content: string, attachments?: string[]) {
  c.send({ type: 'user_message', workflowId: id, content, attachments });
  let text = '', thinking = '', search = false, fetch = false;
  let speed: any;
  const startedTools = new Set<string>();
  let ended = false;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const m = await c.waitFor((m) => m.workflowId === id, Math.min(60000, deadline - Date.now()), 'Strata event');
    events.push(m);
    if (m.type === 'primary_complete') speed = m.genSpeed;
    if (m.type === 'primary_thinking') thinking += String(m.text ?? '');
    if (m.type === 'primary_text') text += String(m.text ?? '');
    if (m.type === 'primary_tool_use') {
      const name = String(m.name ?? m.tool ?? '');
      console.log('tool', name, m.status ?? 'started', m.toolUseId);
      if (m.status === 'started') startedTools.add(String(m.toolUseId));
      if (m.status === 'completed') assert(startedTools.has(String(m.toolUseId)), 'tool completion retains its start ID');
      if (name === 'WebSearch' && m.status === 'completed' && !String(m.output).startsWith('[error]')) search = true;
      if (name === 'WebFetch' && m.status === 'completed' && !String(m.output).startsWith('[error]')) fetch = true;
      if (m.status === 'failed') throw new Error(`Tool failed: ${JSON.stringify(m)}`);
    }
    if (m.type === 'error' || m.type === 'primary_error') throw new Error(JSON.stringify(m));
    if (m.type === 'primary_turn_ended') { ended = true; break; }
  }
  const ctx = await c.waitFor((m) => m.workflowId === id && m.type === 'context_usage', 5000, 'Strata context meter');
  events.push(ctx);
  assert(ctx.windowSize === 262144 && ctx.method === 'ground-truth', 'context uses the discovered native window');
  console.log(JSON.stringify({ id, text, thinkingBytes: thinking.length, search, fetch }));
  assert(ended, 'turn ended within deadline');
  assert(text.length > 0, 'assistant streamed a response');
  assert(speed?.decodeTokens > 0 && speed?.decodeMs > 0, 'actual engine generation timing reached Arco');
  console.log('Native speed:', (speed.decodeTokens / (speed.decodeMs / 1000)).toFixed(1), 'tok/s');
  return { text, thinking, search, fetch };
}
try {
  const chat = await create('chat');
  const web = await turn(chat, 'Use WebSearch now to search for the official Strata inference engine GitHub repository (Niko1221 Strata). Then use WebFetch on https://github.com/Niko1221/Strata and tell me briefly what the project does with the source URL. You must actually call both tools.');
  assert(web.search, 'Chat performed a successful real WebSearch');
  assert(web.fetch, 'Chat performed a successful real WebFetch');
  assert(/github.com\/Niko1221\/Strata/i.test(web.text), 'answer cites the repository');
  const image = process.env.STRATA_SMOKE_IMAGE;
  assert(Boolean(image), 'STRATA_SMOKE_IMAGE names the image fixture');
  const vision = await turn(chat, 'Look at the attached image. What color is the shape on the left, what shape is on the right, and what word is printed at the top? Answer from the image in one sentence.', [image!]);
  assert(/red/i.test(vision.text) && /circle/i.test(vision.text) && /STRATA/i.test(vision.text), 'image answer identifies visual features and text');
  c.send({ type: 'update_primary_config', workflowId: chat, effort: 'medium' });
  await c.waitFor((m) => m.type === 'workflow_config_synced' && m.workflowId === chat, 5000, 'effort updated');
  const reasoning = await turn(chat, 'Compute 17 times 23 and explain briefly.');
  assert(reasoning.thinking.length > 0, 'actual reasoning streamed through Arco');
  assert(/391/.test(reasoning.text), 'reasoned answer is correct');
  const agent = await create('workflow');
  const agentWeb = await turn(agent, 'Use WebSearch to find the official Qwen GitHub repository. Reply with its URL. Do not inspect or change project files.');
  assert(agentWeb.search, 'Agent performed a successful real WebSearch');
  console.log('PASS: Chat search + fetch, image question, and Agent search through Arco');
} finally {
  writeFileSync(join(artifactDir, 'strata-live-events.json'), JSON.stringify(events, null, 2));
  for (const workflowId of ids) c.send({ type: 'remove_workflow', workflowId });
  await c.close();
  console.log('Artifacts:', artifactDir);
}

}
void main().catch((err) => { console.error(err); process.exitCode = 1; });
