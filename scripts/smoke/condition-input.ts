// Real existing Codex subscription, isolated ephemeral Luna LOW, no worker tools.
import assert from 'node:assert/strict';
import { observeInputWithLuna } from '../../server/src/voice/inputObservation.js';
async function main(){
const result=await observeInputWithLuna([
  {id:'human',text:'Operator, which database should I migrate to: Postgres or MySQL? I need your decision before I can continue.'},
  {id:'report',text:'How do we know it works? All 27 tests passed. I finished my change and sent the report to the Director. No input is needed from you.'},
  {id:'peer',text:'I asked Builder 2 to verify the import schema and am continuing with the tests while it checks.'},
  {id:'unknown',text:'[The worker reply could not be retrieved; no reply text is available.]'},
],AbortSignal.timeout(30000));
const values=Object.fromEntries(result.workers.map((w)=>[w.id,w.needs_input]));
assert.equal(values.human,true);assert.equal(values.report,false);assert.equal(values.peer,false);assert.equal(values.unknown,null);
console.log('Luna LOW input observation: 4/4',JSON.stringify({decisions:values,usage:result.usage}));
}
main().catch((e)=>{console.error(e);process.exitCode=1;});
