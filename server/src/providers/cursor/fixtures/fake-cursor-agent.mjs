// Test stand-in for `cursor-agent`, answering from acp-models.json (a capture
// of the real CLI). Modes: `acp`, `models`, `status`, `login`. Behavior is set
// through FAKE_CURSOR_* variables; every ACP request is appended to
// FAKE_CURSOR_LOG as one JSON line.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const fx = JSON.parse(readFileSync(new URL('./acp-models.json', import.meta.url), 'utf8'));
const env = process.env;
const mode = process.argv[2];
const log = (entry) => { if (env.FAKE_CURSOR_LOG) appendFileSync(env.FAKE_CURSOR_LOG, JSON.stringify(entry) + '\n'); };

if (process.argv.includes('-p')) {
  log({ argv: process.argv.slice(2) });
  process.stdin.resume();
  process.stdin.on('end', () => { process.stdout.write('ok\n'); process.exit(0); });
} else if (mode === 'models') {
  process.stdout.write(fx.catalogStdout.join('\n') + '\n');
  process.exit(0);
} else if (mode === 'status') {
  process.stdout.write(env.FAKE_CURSOR_STATUS ?? 'Logged in as user\n');
  process.exit(0);
} else if (mode === 'login') {
  if (env.NO_OPEN_BROWSER === '1') process.stdout.write('Open this link to sign in: https://cursor.example/login?challenge=abc\n');
  else process.stdout.write('Opening browser\n');
  setTimeout(() => { process.stdout.write('Logged in\n'); process.exit(0); }, Number(env.FAKE_CURSOR_LOGIN_MS ?? 300));
} else if (mode === 'acp') {
  log({ argv: process.argv.slice(2) });
  const available = fx.sessionNewResult.models.availableModels.map((m) => m.modelId);
  let current = env.FAKE_CURSOR_LOAD_CURRENT ?? fx.sessionNewResult.models.currentModelId;
  const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const sessionResult = (sessionId) => ({
    ...fx.sessionNewResult,
    sessionId,
    models: { ...fx.sessionNewResult.models, currentModelId: current },
  });
  const invalid = (value) => ({ code: -32602, message: 'Invalid params', data: { message: `Invalid model value: ${value}` } });
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.method === undefined) return;
    log({ method: msg.method, params: msg.params });
    const reply = (result) => send({ id: msg.id, result });
    const fail = (error) => send({ id: msg.id, error });
    switch (msg.method) {
      case 'initialize': return reply(fx.initializeResult);
      case 'session/new':
        if (env.FAKE_CURSOR_AUTH_FAIL === '1') return fail({ code: -32000, message: 'Authentication required' });
        current = fx.sessionNewResult.models.currentModelId;
        return reply(sessionResult('fake-session-1'));
      case 'session/load':
        if (env.FAKE_CURSOR_LOAD_OK !== '1') return fail(fx.sessionLoadUnsavedError);
        return reply(sessionResult(msg.params.sessionId));
      case 'session/set_config_option': {
        if (env.FAKE_CURSOR_NO_CONFIG_OPTION === '1') return fail({ code: -32601, message: 'Method not found' });
        const value = msg.params.value;
        if (env.FAKE_CURSOR_REJECT_SET === '1' || !available.includes(value)) return fail(invalid(value));
        if (env.FAKE_CURSOR_IGNORE_SET !== '1') current = value;
        return reply({ configOptions: fx.sessionNewResult.configOptions.map((o) => (o.id === 'model' ? { ...o, currentValue: current } : o)) });
      }
      case 'session/set_model': {
        const value = msg.params.modelId;
        if (env.FAKE_CURSOR_REJECT_SET === '1' || !available.includes(value)) return fail(invalid(value));
        current = value;
        return reply(fx.setModelResult);
      }
      case 'session/prompt':
        return reply({ stopReason: 'end_turn' });
      default:
        return fail({ code: -32601, message: 'Method not found' });
    }
  });
} else {
  process.stderr.write(`fake cursor-agent: unknown mode ${mode}\n`);
  process.exit(2);
}
