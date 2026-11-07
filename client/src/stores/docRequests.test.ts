import test from 'node:test';
import assert from 'node:assert/strict';
import { useDocEditStore, registerDocEditSender, type DocEditRequestArgs } from './docEditStore';
import { useKnowledgeDistillStore, registerDistillSender } from './knowledgeDistillStore';
const args: DocEditRequestArgs = { workflowId:'fixture', editor:{provider:'claude',model:'fixture',effort:'low'}, filePath:'fixture.txt',selectionText:'before',selectionFrom:0,selectionTo:6,contextBefore:'',contextAfter:'',instruction:'Revise',wholeDoc:true };
test('B37: the editor request key continues to expose the server proposal', () => {
  registerDocEditSender(() => true);
  const key=useDocEditStore.getState().dispatch(args);
  useDocEditStore.getState().onStarted('server-id',args.filePath);
  useDocEditStore.getState().onProposed('server-id',{filePath:args.filePath,selectionFrom:0,selectionTo:6,replacement:'after'});
  assert.equal(useDocEditStore.getState().byId[key]?.replacement,'after');
  useDocEditStore.getState().clear(key); registerDocEditSender(null);
});
test('B38: declined requests settle as retryable errors', () => {
  registerDocEditSender(() => false); registerDistillSender(() => false);
  const key=useDocEditStore.getState().dispatch(args);
  useKnowledgeDistillStore.getState().dispatch({workflowId:'fixture',drafter:args.editor});
  assert.equal(useDocEditStore.getState().byId[key]?.status,'error');
  assert.equal(useKnowledgeDistillStore.getState().byWorkflow.fixture?.status,'error');
  useDocEditStore.getState().clear(key); useKnowledgeDistillStore.getState().clear('fixture');
  registerDocEditSender(null);registerDistillSender(null);
});

test('B38: disconnect settles sent requests that have no reply', () => {
  registerDocEditSender(() => true); registerDistillSender(() => true);
  const key=useDocEditStore.getState().dispatch(args);
  useKnowledgeDistillStore.getState().dispatch({workflowId:'fixture',drafter:args.editor});
  useDocEditStore.getState().onDisconnected(); useKnowledgeDistillStore.getState().onDisconnected();
  assert.equal(useDocEditStore.getState().byId[key]?.status,'error');
  assert.equal(useKnowledgeDistillStore.getState().byWorkflow.fixture?.status,'error');
  useDocEditStore.getState().clear(key);useKnowledgeDistillStore.getState().clear('fixture');
  registerDocEditSender(null);registerDistillSender(null);
});
