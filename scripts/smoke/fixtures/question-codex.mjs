// Deterministic app-server protocol peer. No inference, credentials or network.
import readline from 'node:readline';
if (!process.argv.includes('app-server')) {
  console.log(process.argv.includes('--version') ? 'codex-cli 0.162.1' : process.argv.includes('status') ? 'Logged in using ChatGPT' : 'codex --json --model --config --sandbox --ask-for-approval');
  process.exit(0);
}
const threadId = `questions-${process.pid}`;
const model = 'gpt-5.5';
let turn = 0, currentTurn = '', waiting = false;
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id, result) => out({ id, result });
const notify = (method, params) => out({ method, params });
const finish = (status = 'completed') => notify('turn/completed', { threadId, turn: { id: currentTurn, status, error: null } });
const say = (text) => notify('item/agentMessage/delta', { threadId, turnId: currentTurn, itemId: `say-${turn}`, delta: text });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (!m.method && m.id === 'blocking-question' && waiting) {
    if (m.result?.answers?.destination?.answers?.[0] !== 'Stay' || m.result?.answers?.note?.answers?.[0] !== 'Custom note') throw new Error('Wrong question answer mapping');
    waiting = false; say('Blocking answers received.');
    notify('item/completed', { threadId, turnId: currentTurn, item: { type: 'agentMessage', id: 'async-question', text: 'Which color next?', delivery: 'async', questions: [{ title: 'Which color next?', options: ['Red', 'Blue'] }] } });
    finish(); continue;
  }
  if (!m.method) continue;
  switch (m.method) {
    case 'initialize': reply(m.id, { userAgent: 'codex-fixture/0.162.1' }); break;
    case 'initialized': break;
    case 'account/read': reply(m.id, { account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' }, requiresOpenaiAuth: false }); break;
    case 'model/list': reply(m.id, { data: [{ id: model, model, displayName: model, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }], defaultReasoningEffort: 'high', inputModalities: ['text', 'image'] }], nextCursor: null }); break;
    case 'thread/start': case 'thread/resume': reply(m.id, { thread: { id: threadId }, model }); break;
    case 'thread/goal/clear': reply(m.id, { cleared: false }); break;
    case 'turn/start': {
      currentTurn = `turn-${++turn}`;
      reply(m.id, { turn: { id: currentTurn } });
      notify('turn/started', { threadId, turn: { id: currentTurn } });
      const prompt = JSON.stringify(m.params.input);
      if (prompt.includes('Answers to your questions:')) {
        if (!prompt.includes('Blue')) throw new Error('Async answer was not delivered as operator input');
        say('Async answer received: Blue.'); finish();
      } else {
        waiting = !prompt.includes('cancel-question');
        out({ id: waiting ? 'blocking-question' : 'cancel-question', method: 'item/tool/requestUserInput', params: { threadId, turnId: currentTurn, itemId: `request-${turn}`, isBlocking: true, questions: [
          { id: 'destination', header: 'Destination', question: 'Where should I work?', isOther: false, options: [{ label: 'Stay', description: 'Use this location.' }, { label: 'Move', description: 'Choose another location.' }] },
          { id: 'note', header: 'Note', question: 'Any extra instructions?', isOther: true, options: null },
        ] } });
      }
      break;
    }
    case 'turn/interrupt': waiting = false; reply(m.id, {}); finish('interrupted'); break;
    case 'turn/steer': reply(m.id, { turnId: currentTurn }); break;
    default: if (m.id !== undefined) reply(m.id, {});
  }
}
