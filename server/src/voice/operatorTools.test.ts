import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestVoiceTool, resolveVoiceTool, setVoiceToolPublisher, voiceToolCallsPending } from './operatorTools.js';

test('the relay repairs malformed text and Unicode boundaries for every provider', async () => {
  setVoiceToolPublisher((workflowId,m)=>{queueMicrotask(()=>resolveVoiceTool({type:'voice_tool_result',workflowId,requestId:m.requestId,ok:true,result:'x'.repeat(15999)+'😀\uD83D'}));return 1;});
  assert.deepEqual(await requestVoiceTool('unicode','arco_screen',{}),{ok:true,result:'x'.repeat(15999)});
  setVoiceToolPublisher((workflowId,m)=>{queueMicrotask(()=>resolveVoiceTool({type:'voice_tool_result',workflowId,requestId:m.requestId,ok:true,result:'broken \uD83D middle 😀'}));return 1;});
  assert.deepEqual(await requestVoiceTool('unicode','arco_screen',{}),{ok:true,result:'broken � middle 😀'});
});

test('a stopped Computer rejects late actions and resolves pending tools without replay', async () => {
  const {blockVoiceTools,allowVoiceTools}=await import('./operatorTools.js');
  let sent=0;setVoiceToolPublisher(()=>{sent++;return 1;});
  const pending=requestVoiceTool('stopped','arco_nudge',{target:'Builder'});
  blockVoiceTools('stopped');
  assert.equal((await pending).ok,false);assert.equal(voiceToolCallsPending('stopped'),0);
  assert.equal((await requestVoiceTool('stopped','arco_nudge',{target:'Builder'})).ok,false);
  assert.equal(sent,1);
  allowVoiceTools('stopped');
});

test('voice tool calls relay to the window, resolve on its result, and refuse bad input', async () => {
  const published: Array<{ workflowId: string; tool: string; requestId: string }> = [];
  setVoiceToolPublisher((workflowId, m) => { published.push({ workflowId, tool: m.tool, requestId: m.requestId }); return 1; });
  const pending = requestVoiceTool('chat-1', 'arco_select', { target: 'reviewer' });
  assert.equal(published.length, 1); assert.equal(voiceToolCallsPending('chat-1'), 1);
  assert.equal(resolveVoiceTool({ type: 'voice_tool_result', workflowId: 'other', requestId: published[0].requestId, ok: true, result: 'x' }), false, 'another workflow cannot answer');
  assert.equal(resolveVoiceTool({ type: 'voice_tool_result', workflowId: 'chat-1', requestId: published[0].requestId, ok: true, result: 'Reviewer selected.' }), true);
  assert.deepEqual(await pending, { ok: true, result: 'Reviewer selected.' });
  assert.equal(voiceToolCallsPending('chat-1'), 0);
  assert.deepEqual(await requestVoiceTool('chat-1', 'rm_rf', {}), { ok: false, error: 'Unknown voice tool.' });
  assert.deepEqual(await requestVoiceTool('chat-1', 'arco_send_message', { text: 42 }), { ok: false, error: 'Invalid tool arguments.' });
  setVoiceToolPublisher(() => 0);
  assert.deepEqual(await requestVoiceTool('chat-1', 'arco_status', {}), { ok: false, error: 'No window is subscribed to the Computer chat.' });
  assert.equal(published.length, 1);
});

test('a window that never answers times out instead of hanging the model', async () => {
  setVoiceToolPublisher(() => 1);
  const started = Date.now();
  const result = await Promise.race([requestVoiceTool('chat-2', 'arco_status', {}), new Promise((r) => setTimeout(r, 25_000, 'hung'))]);
  assert.deepEqual(result, { ok: false, error: 'No hands-free window answered in time.' });
  assert(Date.now() - started >= 19_000);
});

// Shared native/MCP definitions must never expose project tools to Computer.
test('Computer definitions advertise one bounded surface and validate before relay', async () => {
  const { computerToolDefinitions, executeComputerTool } = await import('./toolDefinitions.js');
  const names = computerToolDefinitions().map((t) => t.function.name);
  assert(names.includes('arco_computer')); assert(names.every((n) => n.startsWith('arco_')));
  const { ollamaToolCandidates, ollamaToolCallAllowed } = await import('../providers/ollama.js');
  const config = { cwd: '/tmp', interactionMode: 'chat' as const, voiceOperator: true };
  assert.deepEqual(ollamaToolCandidates(config)?.map((t) => t.function.name), names);
  assert.equal(ollamaToolCallAllowed(config, 'Bash'), false);
  assert.equal(ollamaToolCallAllowed(config, 'arco_computer'), true);
  let calls = 0;
  setVoiceToolPublisher((workflowId, m) => { calls++; queueMicrotask(() => resolveVoiceTool({ type: 'voice_tool_result', workflowId, requestId: m.requestId, ok: true, result: 'queued' })); return 1; });
  assert.match(await executeComputerTool('private', 'Bash', {}), /not available/);
  assert.match(await executeComputerTool('private', 'arco_computer', { action: 'reset', extra: 'bad' }), /Invalid/);
  assert.equal(calls, 0);
  assert.equal(await executeComputerTool('private', 'arco_computer', { action: 'reset' }), 'queued');
  assert.equal(calls, 1);
  const { ClaudeNativeWorker } = await import('../providers/claude-native/worker.js');
  const native = new ClaudeNativeWorker({ workflowId: 'private', config: { model: 'haiku', effort: 'low', interactionMode: 'chat', voiceOperator: true } });
  const surface = native as unknown as { buildToolDefs(): Array<{name:string}>; dispatchTool(block: unknown): Promise<{text:string;isError:boolean}> };
  assert.deepEqual(surface.buildToolDefs().map((t) => t.name), names);
  assert.deepEqual(await surface.dispatchTool({id:'reset',name:'arco_computer',input:{action:'reset'}}), {text:'queued',isError:false});
  assert.deepEqual(await surface.dispatchTool({id:'shell',name:'Bash',input:{command:'pwd'}}), {text:'[error] Tool is not available in Computer.',isError:true});
  await native.dispose();
});


test('local Computer replay keeps tool calls/results as structured history instead of teaching text-only Done', async () => {
  const { renderComputerHistory, parseComputerHistory } = await import('./history.js');
  const history = parseComputerHistory(renderComputerHistory([
    {type:'user_message_echo',workflowId:'c',content:'open the project',timestamp:1},
    {type:'primary_tool_use',workflowId:'c',tool:'arco_select',input:'{"target":"Project"}',toolUseId:'call-1',status:'started'},
    {type:'primary_tool_use',workflowId:'c',tool:'arco_select',input:'{"target":"Project"}',toolUseId:'call-1',status:'completed',output:'Project selected.'},
    {type:'primary_text',workflowId:'c',text:'Done.',phase:'passthrough'},
  ]));
  assert.deepEqual(history.map((m)=>m.role),['user','assistant','tool','assistant']);
  assert.equal(history[1].tool_calls?.[0].function.name,'arco_select');
  assert.deepEqual(history[1].tool_calls?.[0].function.arguments,{target:'Project'});
  assert.equal(history[2].tool_call_id,'call-1'); assert.equal(history[2].content,'Project selected.');
  assert.equal(history[3].content,'Done.'); assert.deepEqual(parseComputerHistory(renderComputerHistory([])),[]);
});

test('background event updates cannot invoke tools, and stale cleanup cannot unlock a newer update', async()=>{
  const {setComputerBackgroundClaim,clearComputerBackgroundClaim}=await import('./operatorTools.js');
  let sent=0;setVoiceToolPublisher(()=>{sent++;return 1;});
  setComputerBackgroundClaim('feed',1);
  assert.equal((await requestVoiceTool('feed','arco_nudge',{target:'Builder'})).ok,false);
  assert.equal((await requestVoiceTool('feed','arco_act',{control:'1',action:'click'})).ok,false);
  setComputerBackgroundClaim('feed',2);clearComputerBackgroundClaim('feed',1);
  assert.equal((await requestVoiceTool('feed','arco_activity',{action:'configure',enabled:'true'})).ok,false);
  assert.equal(sent,0);clearComputerBackgroundClaim('feed',2);
});
