import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { validateSettings } from '../utils/settingsResponse';

test('B173 refused operator-name save preserves settings and reports an error',async()=>{
  const source=await readFile(new URL('../components/SettingsPanel.tsx',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('  const commitOperatorName ='),source.indexOf('  const toggleProviderEnabled ='));
  let settings:any={enabledProviders:{claude:true},operatorName:'previous',themeId:'fixture'};const original=settings;const notices:string[]=[];
  const readSavedSettings=async(response:Response)=>{if(!response.ok){notices.push('Settings could not be saved.');throw Error('failed');}return response.json();};
  const transformed=await transform(code+'\nreturn commitOperatorName;', {loader:'ts'});
  const run=new Function('operatorDraft','settings','setOperatorSaving','setOperatorDraft','fetch','setSettings','readSavedSettings',transformed.code)('next',settings,()=>{},()=>{},async()=>new Response('{"error":"disk unavailable"}',{status:500}),(value:any)=>{settings=value;},readSavedSettings);
  await run();assert.equal(settings,original);assert.equal(notices.length,1);
});
test('B173 malformed settings never reach appearance or live state',async()=>{
  const source=await readFile(new URL('./appStore.ts',import.meta.url),'utf8');
  const start=source.indexOf('  setSettings: (settings) => {');const end=source.indexOf('\n  setPhosphorPreference:',start);
  const body=source.slice(start,end).replace(/^  setSettings: /,'').trim().replace(/,$/,'');
  let writes=0,appearance=0,errors=0;
  const transformed=await transform('return ('+body+');',{loader:'ts'});
  const run=new Function('validateSettings','get','set','applyPhosphorPreferences','applyUiScale','writeCachedUiScale','applyThemeForSelection','writeCachedThemeId','writeCachedFontPackOverride','writeCachedFrostedOverride','writeCachedFrostedOpacity','writeCachedBgBrightness','writeCachedTextBrightness','applyCrispText','writeCachedCrispText','brightnessOf','DEFAULT_THEME_ID',transformed.code)(validateSettings,()=>({pushNotification:()=>errors++,getActiveJob:()=>undefined}),()=>writes++,()=>appearance++, ...Array(12).fill(()=>{}),'fixture');
  run({error:'failed'});assert.equal(writes,0);assert.equal(appearance,0);assert.equal(errors,1);
});

test('B173 refused provider toggle keeps the complete settings when reload also fails',async()=>{
  const source=await readFile(new URL('../components/SettingsPanel.tsx',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('  const toggleProviderEnabled ='),source.indexOf('  const commitOllamaBaseUrl ='));
  const original={enabledProviders:{claude:true},themeId:'fixture',uiScale:1.5,operatorName:'fixture'};let live:any=original;
  const transformed=await transform(code+'\nreturn toggleProviderEnabled;',{loader:'ts'});
  const run=new Function('savingProvider','settings','setSavingProvider','setSettings','fetch','readSavedSettings',transformed.code)(null,original,()=>{},(s:any)=>{live=s;},async()=>new Response('{"error":"unavailable"}',{status:500}),async()=>{throw Error('refused');});
  await run('claude');assert.equal(live,original);
});
