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
  assert.ok(args.includes('features.goals=false'));
  assert.ok(args.includes('agents.enabled=false'));
  assert.ok(args.includes('features.code_mode.excluded_tool_namespaces=["functions"]'));
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
  assert.ok(!args.includes('agents.enabled=false'));
  assert.ok(!args.includes('features.goals=false'));
  assert.ok(!args.some((arg:string)=>arg.startsWith('features.code_mode.excluded_tool_namespaces=')));
  assert.ok(args.some((a:string)=>/^(?:features|tools)\.view_image=true$/.test(a)));
});

const { supportsCodexChat, codexChatOverrides }=await import('./codexChatBoundary.js');
const listedFeatures=['shell_tool','view_image','apps','plugins','remote_plugin','multi_agent','goals',
  'image_generation','memories','hooks','computer_use','code_mode','code_mode_host'].map(name=>`${name} stable true`).join('\n');
const validProbe={listedFeatures, version:'codex-cli 0.167.0',features:listedFeatures.replaceAll('stable true','stable false'),
  execHelp:'--ignore-user-config --ignore-rules --strict-config',resumeHelp:'--ignore-user-config --ignore-rules --strict-config',startupConfig:JSON.stringify({appServerVersion:'0.167.1'})};
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

for (const web of [false,true]) for (const resume of [false,true]) test(`WEB ${web ? 'armed' : 'off'} ${resume ? 'resume' : 'start'} preserves the required host policy`,()=>{
  const worker=CodexProvider.create('web-policy',{...base,chatWebAccess:web,...(resume?{resumeSessionId:'fixture-thread'}:{})}) as any;
  worker.chatOverrides=codexChatOverrides(listedFeatures,web);
  const args=worker.buildArgs();
  assert.ok(args.includes(`features.code_mode_host=${web}`));
  assert.ok(args.includes('features.goals=false'));
  assert.ok(args.includes('agents.enabled=false'));
  assert.ok(args.includes('features.code_mode.excluded_tool_namespaces=["functions"]'));
  assert.ok(args.includes('features.code_mode=false'));
  assert.ok(args.includes('features.shell_tool=false'));
  assert.ok(args.includes('features.view_image=false'));
  assert.ok(args.includes(`web_search="${web?'live':'disabled'}"`));
});
test('WEB capability checks require an enabled host and keep every other listed reader off',()=>{
  const webProbe={...validProbe,features:validProbe.features.replace('code_mode_host stable false','code_mode_host stable true')};
  assert.equal(supportsCodexChat(webProbe,true),true);
  assert.equal(supportsCodexChat(validProbe,true),false);
  assert.equal(supportsCodexChat({...webProbe,features:webProbe.features.replace('code_mode_host stable true','code_mode_host removed true')},true),false);
  assert.equal(supportsCodexChat(webProbe,false),false);
  assert.equal(supportsCodexChat({...webProbe,features:webProbe.features.replace('shell_tool stable false','shell_tool stable true')},true),false);
  assert.equal(supportsCodexChat({...webProbe,listedFeatures:'shell_tool stable true\nview_image stable true'},true),false);
});

test('capability cache follows WEB changes and probes the matching overrides',async t=>{
  const childProcess=(await import('node:child_process')).default;
  const {syncBuiltinESMExports}=await import('node:module');
  const {requireCodexChatCapabilities}=await import('./codexChatBoundary.js');
  const probes:string[][]=[];
  t.mock.method(childProcess,'spawnSync',((_command:string,args:string[])=>{
    probes.push(args);
    const stdout=args.includes('--print-startup-config')?validProbe.startupConfig:args.includes('--version')?validProbe.version:args.includes('--help')?validProbe.execHelp:
      args.includes('-c')?validProbe.features.replace('code_mode_host stable false',`code_mode_host stable ${args.includes('features.code_mode_host=true')}`):listedFeatures;
    return {status:0,stdout};
  }) as any);
  syncBuiltinESMExports();
  try {
    const probeHome=join(home,'web-cache');
    assert.ok(requireCodexChatCapabilities(probeHome,false).includes('features.code_mode_host=false'));
    assert.ok(probes.some(args=>args.includes('--print-startup-config')&&args.includes('--strict-config')&&args.includes('agents.enabled=false')&&args.includes('features.code_mode.excluded_tool_namespaces=["functions"]')));
    assert.ok(requireCodexChatCapabilities(probeHome,true).includes('features.code_mode_host=true'));
    assert.equal(probes.length,12,'WEB change must invalidate a cached off policy');
    requireCodexChatCapabilities(probeHome,true);
    assert.equal(probes.length,12,'same WEB policy should reuse its cached capability result');
    assert.ok(requireCodexChatCapabilities(probeHome,false).includes('features.code_mode_host=false'));
    assert.equal(probes.length,12,'switching back within expiry should reuse the earlier policy');
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('Chat refuses an unsupported namespace or agent control before a model turn',()=>{
 assert.equal(supportsCodexChat({...validProbe,startupConfig:undefined}),false);
 assert.equal(supportsCodexChat({...validProbe,startupConfig:JSON.stringify({error:{message:'unknown configuration field agents.enabled'}})}),false);
 assert.equal(supportsCodexChat({...validProbe,features:validProbe.features.replace('goals stable false','goals stable true')}),false);
 assert.equal(supportsCodexChat({...validProbe,listedFeatures:validProbe.listedFeatures.replace(/goals[^\n]*\n/, '')}),false);
});
