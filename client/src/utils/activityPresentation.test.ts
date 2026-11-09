import test from 'node:test';
import assert from 'node:assert/strict';
import { activeActivity, canPlanFirst, describeTool, settledCardPreview } from './activityPresentation.js';
import type { JobState } from '../stores/appStore.js';
const entry = { id: 't', kind: 'tool_use' as const, tool: 'Read', input: JSON.stringify({file_path:'src/example.ts'}), at: 100, status: 'started' as const };
test('activity names describe the action and retain the whole file path', () => {
  assert.equal(describeTool(entry), 'Reading src/example.ts');
  assert.equal(describeTool({...entry, tool:'mcp__arco_cluster__cluster_task_create'}), 'Creating board task');
  assert.deepEqual(activeActivity([entry], 0), {key:'t', label:'Reading src/example.ts', at:100});
});
test('member previews ignore streaming and thinking and keep the last settled item', () => {
  const job = {messages:[{role:'assistant', content:'Last answer.', timestamp:1, isStreaming:false},{role:'assistant', content:'half sentence', timestamp:2, isStreaming:true}],activity:[{...entry,status:'completed',updatedAt:3},{id:'reason',kind:'thinking',text:'private fragment',at:4}]} as unknown as JobState;
  assert.equal(settledCardPreview(job), 'Reading src/example.ts');
  job.activity = [{id:'reason',kind:'thinking',text:'private fragment',at:4}];
  assert.equal(settledCardPreview(job), 'Last answer.');
});
test('plan first is hidden for director and reviewer roles', () => {
  for(const role of ['Director role. Delegate','Coordinator','Reviewer role. Read']) assert.equal(canPlanFirst(role),false);
  for(const role of [undefined,'Builder role. Implement','Tester role. Test']) assert.equal(canPlanFirst(role),true);
});
