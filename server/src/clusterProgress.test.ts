import test from 'node:test';
import assert from 'node:assert/strict';
import {buildProgressDoctrine} from './clusterProgress.js';

for(const mode of ['plan','board','both'] as const)for(const hasPlan of [false,true])for(const hasBoard of [false,true])test(`${mode}, plan=${hasPlan}, board=${hasBoard}: approved work instructions follow the attached plan`,()=>{
 const text=buildProgressDoctrine(mode,hasPlan,hasBoard)??'';
 if(hasPlan&&mode!=='board'){
  assert.match(text,/operator approves new work/);
  assert.match(text,/same turn, before assigning/);
  assert.match(text,/one item per feature or batch of fixes, never one per bug/);
  assert.match(text,/item id and a one-line description/);
  assert.match(text,/When a whole plan item is complete/);
 }else{
  assert.doesNotMatch(text,/operator approves new work|one item per feature|item id and a one-line description/);
 }
 if(hasBoard&&mode!=='plan')assert.match(text,/done\/archived status changes stay operator-only/);
 if(hasBoard&&hasPlan&&mode==='both')assert.match(text,/completePlan/);
});
