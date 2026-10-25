import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useAppStore } from '../stores/appStore';
import { useVoiceStore } from './store';
import { COMPUTER_WORKING, computerRequestActive, computerVoiceStatus } from './computerRequest';
import { allowComputerTextTools, dispatchVoiceToolCall, registerVoiceToolHandler } from './toolBridge';

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } });

afterEach(() => {
  registerVoiceToolHandler(null, null);
  useAppStore.getState().removeJob('computer-text');
  useVoiceStore.setState({ enabled: false });
});

function setup() {
  useAppStore.setState({ connected: true });
  useVoiceStore.setState({ enabled: false });
  useAppStore.getState().createJob('computer-text', {
    kind: 'chat', voiceOperator: true, name: 'Computer', workingDirectory: '', skipPermissions: false,
    primaryProvider: 'codex', primaryModel: 'gpt-6-luna', primaryEffort: 'low',
  });
  registerVoiceToolHandler('computer-text', async () => 'Targets read.');
}

const call = (id = 'computer-text') => ({ type: 'voice_tool_call' as const, workflowId: id, requestId: 'r', tool: 'arco_targets' as const, args: {} });

test('a stale working message becomes idle while queue/reset settlement remains stoppable', () => {
  setup();
  const job = useAppStore.getState().jobs['computer-text'];
  assert.match(computerVoiceStatus(COMPUTER_WORKING, job), /Computer is idle/);
  assert.equal(computerVoiceStatus('Which workers?', job), 'Which workers?');
  for (const update of [{ busy: true }, { computerTurnActive: true }, { queue: { steering: [], followUp: [{ content: 'follow-up' }] } }]) {
    const active = { ...job, ...update } as typeof job;
    assert.equal(computerRequestActive(active), true);
    assert.equal(computerVoiceStatus(COMPUTER_WORKING, active), COMPUTER_WORKING);
  }
});

test('mic-off tools need an explicit typed request for that exact Computer and expire at settlement', async () => {
  setup();
  const sent: unknown[] = [];
  assert.equal(await dispatchVoiceToolCall(call(), (result) => sent.push(result)), false);
  allowComputerTextTools('computer-text');
  assert.equal(await dispatchVoiceToolCall(call('other-chat'), (result) => sent.push(result)), false);
  assert.equal(await dispatchVoiceToolCall(call(), (result) => sent.push(result)), true);
  const update = (busy: boolean, computerTurnActive: boolean) => useAppStore.setState((s) => ({ jobs: {
    ...s.jobs, 'computer-text': { ...s.jobs['computer-text'], busy, computerTurnActive },
  } }));
  update(true, true); update(false, true);
  assert.equal(await dispatchVoiceToolCall(call(), (result) => sent.push(result)), true);
  update(false, false);
  assert.equal(await dispatchVoiceToolCall(call(), (result) => sent.push(result)), false);
  assert.equal(sent.length, 2);
  assert.equal(useVoiceStore.getState().enabled, false);
});

test('failed sends, disconnects and a changed Computer revoke typed tool access', async () => {
  setup();
  const revoke = allowComputerTextTools('computer-text'); revoke();
  assert.equal(await dispatchVoiceToolCall(call(), () => {}), false);
  allowComputerTextTools('computer-text'); useAppStore.setState({ connected: false });
  assert.equal(await dispatchVoiceToolCall(call(), () => {}), false);
  useAppStore.setState({ connected: true }); allowComputerTextTools('computer-text');
  registerVoiceToolHandler('another-computer', async () => 'Wrong window.');
  registerVoiceToolHandler('computer-text', async () => 'Targets read.');
  assert.equal(await dispatchVoiceToolCall(call(), () => {}), false);
});
