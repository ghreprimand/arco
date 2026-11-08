import test from 'node:test';
import assert from 'node:assert/strict';
import { useAppStore } from '../stores/appStore';
import { useDraftStore, readDraft } from '../stores/draftStore';
import { requestQueuedMessageEdit, finishQueuedMessageEdit } from './queuedMessageEdit';

function fixture() {
  const app = useAppStore.getState(), draft = useDraftStore.getState();
  const sent: any[] = [], notices: string[] = [];
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  useAppStore.setState({ connected: true, connectionState: 'online', jobs: {}, attachments: {}, wsSendRaw: m => { sent.push(m); }, pushNotification: (_, text) => { notices.push(text); } });
  useAppStore.getState().createJob('fixture', { name: 'Fixture', primaryProvider: 'codex', primaryModel: 'fixture', primaryEffort: 'low', workingDirectory: '/projects/fixture' } as any);
  useDraftStore.setState({ drafts: {}, queueEditKinds: {} } as any);
  return { sent, notices, close() { useAppStore.setState(app, true); useDraftStore.setState(draft, true); } };
}
test('EDIT appends to the draft at reply time, restores attachments/kind, and ignores duplicate replies', () => {
  const f = fixture();
  try {
    useDraftStore.getState().setDraft('fixture', 'Existing draft');
    useAppStore.getState().addAttachment('fixture', {path:'/projects/fixture/existing.txt',filename:'existing.txt',isImage:false});
    requestQueuedMessageEdit('fixture', 'queued');
    useDraftStore.getState().setDraft('fixture', 'Existing draft with later typing');
    const result = { type: 'queued_message_edit_result', workflowId: 'fixture', clientMessageId: 'queued', requestId: f.sent[0].editRequestId, item: { content: 'Queued text', kind: 'follow-up', attachments: ['/projects/fixture/existing.txt', '/projects/fixture/diagram.png'] } } as any;
    finishQueuedMessageEdit(result); finishQueuedMessageEdit(result);
    assert.equal(readDraft('fixture'), 'Existing draft with later typing\n\nQueued text');
    assert.equal((useDraftStore.getState() as any).queueEditKinds.fixture, 'follow-up');
    assert.deepEqual(useAppStore.getState().attachments.fixture.map(a => a.path), ['/projects/fixture/existing.txt', '/projects/fixture/diagram.png']);
    useDraftStore.getState().setDraft('fixture', '');
    assert.equal((useDraftStore.getState() as any).queueEditKinds.fixture, undefined);
  } finally { f.close(); }
});
test('a stale queue removal leaves the current draft and attachments untouched', () => {
  const f = fixture();
  try {
    useDraftStore.getState().setDraft('fixture', 'Kept');
    requestQueuedMessageEdit('fixture', 'delivered');
    finishQueuedMessageEdit({ type: 'queued_message_edit_result', workflowId: 'fixture', clientMessageId: 'delivered', requestId: f.sent[0].editRequestId, error: 'Already sent, nothing to edit' });
    assert.equal(readDraft('fixture'), 'Kept'); assert.equal(useAppStore.getState().attachments.fixture, undefined);
    assert.deepEqual(f.notices, ['Already sent, nothing to edit']);
  } finally { f.close(); }
});
test('another observer or a mismatched workflow cannot restore an edit reply', () => {
  const f = fixture();
  try {
    requestQueuedMessageEdit('fixture', 'queued');
    finishQueuedMessageEdit({ type: 'queued_message_edit_result', workflowId: 'other', clientMessageId: 'queued', requestId: f.sent[0].editRequestId, item: { content: 'Wrong', kind: 'steer' } });
    assert.equal(readDraft('other'), ''); assert.equal(readDraft('fixture'), '');
    finishQueuedMessageEdit({ type: 'queued_message_edit_result', workflowId: 'fixture', clientMessageId: 'queued', requestId: f.sent[0].editRequestId, error: 'Already sent, nothing to edit' });
  } finally { f.close(); }
});

test('reconnect retries keep the same edit identity and offline clicks send nothing', () => {
  const f = fixture();
  try {
    requestQueuedMessageEdit('fixture','retry'); requestQueuedMessageEdit('fixture','retry');
    assert.equal(f.sent[0].editRequestId,f.sent[1].editRequestId);
    finishQueuedMessageEdit({type:'queued_message_edit_result',workflowId:'fixture',clientMessageId:'retry',requestId:f.sent[0].editRequestId,error:'Already sent, nothing to edit'});
    useAppStore.setState({connectionState:'connecting'});
    assert.equal(requestQueuedMessageEdit('fixture','offline'),false);
    assert.equal(f.sent.length,2);
  } finally {f.close();}
});

test('LA05: EDIT merges skill references into the owning draft without duplicates or cross-tab changes', () => {
  const f = fixture();
  try {
    useDraftStore.setState({ queueEditSkills: { fixture: [{ scope: 'global', slug: 'existing' }], other: [{ scope: 'builtin', slug: 'kept' }] } } as any);
    useDraftStore.getState().setDraft('fixture', 'Existing draft');
    requestQueuedMessageEdit('fixture', 'skill-message');
    finishQueuedMessageEdit({ type: 'queued_message_edit_result', workflowId: 'fixture', clientMessageId: 'skill-message', requestId: f.sent[0].editRequestId, item: { content: 'Use the rule', kind: 'steer', pickedSkills: [{ scope: 'project', slug: 'fixture' }, { scope: 'global', slug: 'existing' }, { scope: 'builtin', slug: 'grill-me' }] } } as any);
    assert.deepEqual((useDraftStore.getState() as any).queueEditSkills.fixture, [{ scope: 'global', slug: 'existing' }, { scope: 'project', slug: 'fixture' }, { scope: 'builtin', slug: 'grill-me' }]);
    assert.deepEqual((useDraftStore.getState() as any).queueEditSkills.other, [{ scope: 'builtin', slug: 'kept' }]);
    useDraftStore.getState().clearDraft('fixture');
    assert.equal((useDraftStore.getState() as any).queueEditSkills.fixture, undefined);
  } finally { f.close(); }
});
