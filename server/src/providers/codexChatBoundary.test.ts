import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkerConfig } from '@arco/shared';
const home=mkdtempSync(join(tmpdir(),'arco-codex-chat-'));
process.env.ARCO_HOME=home;
after(()=>rmSync(home,{recursive:true,force:true}));
const { CodexProvider }=await import('./codex.js');
const { createProviderProcess }=await import('./index.js');

const base: WorkerConfig = {provider:'codex', model:'fixture', effort:'low', workflowId:'fixture', interactionMode:'chat'};
for (const resume of [false,true]) test(`Chat ${resume ? 'resume' : 'start'} cannot advertise command or image readers`, () => {
  const worker = CodexProvider.create('fixture',{...base,...(resume?{resumeSessionId:'fixture-thread'}:{})}) as any;
  const args=worker.buildArgs(['/explicit-attachment.png']);
  assert.ok(args.includes('features.shell_tool=false'));
  assert.ok(args.includes('features.view_image=false'));
  assert.ok(!args.includes('features.view_image=true'));
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--ignore-rules'));
  assert.ok(args.includes('--strict-config'));
  assert.equal(args[args.indexOf('-i')+1],'/explicit-attachment.png');
});
test('ordinary Chat configured app-server creates exec; Agent and Computer keep app-server',()=>{
  const chat=createProviderProcess('fixture',{...base,codexTransport:'appserver'}) as any;
  assert.equal(typeof chat.buildArgs,'function','ordinary Chat must be the exec process');
  const agent=createProviderProcess('fixture-agent',{...base,interactionMode:'agent',codexTransport:'appserver'}) as any;
  assert.equal(agent.buildArgs,undefined);
  const computer=createProviderProcess('fixture-computer',{...base,voiceOperator:true,codexTransport:'appserver'}) as any;
  assert.equal(computer.buildArgs,undefined);
});
test('Agent keeps the image reader and does not get Chat feature restrictions',()=>{
  const worker=CodexProvider.create('agent',{...base,interactionMode:'agent'}) as any;
  const args=worker.buildArgs();
  assert.ok(!args.includes('features.shell_tool=false'));
  assert.ok(!args.includes('--ignore-user-config'));
  assert.ok(args.some((a:string)=>/^(?:features|tools)\.view_image=true$/.test(a)));
});

const { supportsCodexChat, codexChatOverrides }=await import('./codexChatBoundary.js');
const listedFeatures=['shell_tool','view_image','apps','plugins','remote_plugin','multi_agent',
  'image_generation','memories','hooks','computer_use','code_mode','code_mode_host'].map(name=>`${name} stable true`).join('\n');
const validProbe={listedFeatures, version:'codex-cli 0.167.0',features:listedFeatures.replaceAll('stable true','stable false'),
  execHelp:'--ignore-user-config --ignore-rules --strict-config',resumeHelp:'--ignore-user-config --ignore-rules --strict-config'};
test('capability gate refuses missing, removed, ignored and re-enabled readers',()=>{
  assert.equal(supportsCodexChat(validProbe),true);
  assert.equal(supportsCodexChat({}),false);
  assert.equal(supportsCodexChat({...validProbe,version:'codex-cli 0.166.0'}),false);
  assert.equal(supportsCodexChat({...validProbe,resumeHelp:'--ignore-user-config'}),false);
  assert.equal(supportsCodexChat({...validProbe,features:validProbe.features.replace('shell_tool stable false','shell_tool stable true')}),false);
  assert.equal(supportsCodexChat({...validProbe,features:validProbe.features.replace('view_image stable false','view_image removed false')}),false);
});
test('unsupported installation emits a plain error without spawning a model or decoding attachments',async t=>{
  const childProcess=(await import('node:child_process')).default;
  const {syncBuiltinESMExports}=await import('node:module');
  let spawned=false;
  t.mock.method(childProcess,'spawnSync',(()=>({status:1,stdout:''})) as any);
  t.mock.method(childProcess,'spawn',(()=>{spawned=true;throw new Error('must not spawn');}) as any);
  syncBuiltinESMExports();
  try {
    const worker=CodexProvider.create('unsupported',{...base,codexHome:join(home,'unsupported'),attachments:[join(home,'does-not-exist.docx')]});
    let error='';worker.on('error',m=>{error=m;});worker.spawn('Read a file');
    assert.match(error,/Codex Chat is unavailable/);assert.equal(spawned,false);assert.equal(worker.status,'failed');
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('an absent optional feature is omitted; a listed optional reader must turn off',()=>{
  const listing=validProbe.features.replace('code_mode_host stable false\n','').replace(/\ncode_mode_host stable false$/,'');
  assert.equal(supportsCodexChat({...validProbe,listedFeatures:listing,features:listing}),true);
  assert.ok(!codexChatOverrides(listing).includes('features.code_mode_host=false'));
  const worker=CodexProvider.create('optional-absent',base) as any;
  worker.chatOverrides=codexChatOverrides(listing);
  assert.ok(!worker.buildArgs().includes('features.code_mode_host=false'));
  assert.equal(supportsCodexChat({...validProbe,listedFeatures:listing.replace(/view_image[^\n]*\n/, '')}),false);
  assert.equal(supportsCodexChat({...validProbe,listedFeatures:validProbe.features,features:validProbe.features.replace('apps stable false','apps stable true')}),false);
  assert.equal(supportsCodexChat({...validProbe,features:validProbe.features.replace('apps stable false','apps removed false')}),true);
});
test('saved app-server Chat keeps its provider session when the next message runs on exec',()=>{
  const session='aaaaaaaa-1234-1234-1234-123456789abc';
  const worker=createProviderProcess('saved-chat',{...base,codexTransport:'appserver',resumeSessionId:session}) as any;
  const args=worker.buildArgs();
  assert.deepEqual(args.slice(0,3),['exec','resume',session]);
  assert.equal(worker.config.resumeSessionId,session);
  assert.ok(args.includes('features.shell_tool=false'));
});
