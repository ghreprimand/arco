import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import type { ProviderName } from '../../shared/src/protocol/providers';
import { renderToStaticMarkup } from 'react-dom/server';
import { MANUAL_SECTIONS } from '../../client/src/help/manualSections/index';
import { HELP_CONTENT } from '../../client/src/help/content/index';
import { Table, stringifyNode } from '../../client/src/components/UserManual/components';
import { GROUPS } from '../../client/src/components/UserManual/manualTypes';
import { CHAT_PROVIDERS, CHAT_WEB_PROVIDERS, INCOGNITO_CHAT_PROVIDERS } from '../../server/src/chatMode';
import { CODEX_MODEL_INFO, DEFAULT_CODEX_MODEL } from '../../shared/src/protocol/models';
import { CLASSIC_THEME_IDS, VALID_THEME_IDS } from '../../shared/src/protocol/themes';

const section = (id: string) => {
  const found = MANUAL_SECTIONS.find(s => s.id === id);
  assert.ok(found, `missing manual section: ${id}`);
  return stringifyNode(found.body).replace(/\s+/g, ' ');
};

test('assembled manual renders, has unique IDs/groups, and all help links resolve', () => {
  const ids = MANUAL_SECTIONS.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of MANUAL_SECTIONS) {
    assert.ok((GROUPS as readonly string[]).includes(s.group), `${s.id}: invisible TOC group ${s.group}`);
    assert.ok(renderToStaticMarkup(createElement('article', null, s.body)).length > 0);
  }
  for (const [key, help] of Object.entries(HELP_CONTENT)) {
    assert.ok(renderToStaticMarkup(createElement('article', null, help.body)).length > 0, key);
    if (help.manualSection) assert.ok(ids.includes(help.manualSection), key);
  }
});

test('recent controls have focused help and reachable manual destinations', () => {
  const targets: Record<string, string> = {
    'creator.chat-mode': 'chat-mode', 'creator.incognito': 'incognito-chat',
    'creator.past-chats': 'past-chats', 'chat.input': 'chat-mode',
    'chat.send': 'chat-mode', 'chat.stop': 'chat-mode',
    'settings.phosphor-effects': 'settings-themes', 'settings.phosphor-softness': 'settings-themes',
    'rightpanel.config.thinking-visibility': 'provider-recovery',
    'composer.compact': 'provider-recovery', 'header.archive': 'archive-explorer',
    'header.cli-versions': 'provider-updates',
    'header.free-vram': 'strata-recovery',
    'settings.strata-endpoint': 'provider-strata',
    'settings.cli-versions': 'provider-updates',
    'composer.footer.speed': 'token-tracking',
    'creator.model': 'live-config-swap', 'creator.effort': 'live-config-swap',
    'settings.enabled-providers': 'settings-providers',
    'settings.authentication': 'settings-providers',
    'header.strata-version': 'provider-updates',
  };
  for (const [key, id] of Object.entries(targets)) assert.equal(HELP_CONTENT[key]?.manualSection, id, key);
});

test('privacy and model/theme documentation stays aligned with current contracts', () => {
  const names: Record<string, string> = { claude: 'Claude', codex: 'Codex', zai: 'Z.ai', cursor: 'Cursor', ollama: 'Ollama', llamacpp: 'llama.cpp', lmstudio: 'LM Studio', strata: 'Strata', deepseek: 'DeepSeek' };
  for (const provider of CHAT_PROVIDERS) {
    assert.ok(names[provider], `provider missing from documentation check: ${provider}`);
    assert.ok(section('chat-mode').includes(names[provider]));
  }
  const webHelp = stringifyNode(HELP_CONTENT['chat.web'].body);
  for (const provider of CHAT_WEB_PROVIDERS) assert.ok(webHelp.includes(names[provider]), `Chat web help omits ${provider}`);
  const incognito = section('incognito-chat');
  const supported = incognito.split('Supported: ')[1]?.split('. Cursor')[0] ?? '';
  for (const [id, name] of Object.entries(names)) assert.equal(supported.includes(name), INCOGNITO_CHAT_PROVIDERS.has(id as ProviderName), name);
  assert.match(incognito, /provider-side deletion or anonymity/);
  assert.match(incognito, /Closing or refreshing.*restarting Arco.*loses the chat/);
  const codex = section('provider-codex');
  assert.ok(codex.includes(DEFAULT_CODEX_MODEL));
  for (const effort of CODEX_MODEL_INFO[DEFAULT_CODEX_MODEL].supportedEfforts ?? []) assert.ok(codex.includes(effort));
  const themes = section('settings-themes');
  assert.ok(themes.includes(String(CLASSIC_THEME_IDS.length)));
  assert.ok(themes.includes(String(VALID_THEME_IDS.length - CLASSIC_THEME_IDS.length)));
});

test('manual search includes visible table headings and cells, not just children', () => {
  const table = createElement(Table, { headers: ['Provider'], rows: [['searchable-model-marker']] });
  assert.match(stringifyNode(table), /Provider.*searchable-model-marker/);
  assert.match(section('providers-overview'), /session\/load/);
});


test('Strata manual is searchable, distinguishes memory limits, and opens the real runbook', () => {
  const provider = section('provider-strata');
  for (const term of ['Original', 'SC117 Abliterated', 'none', 'low', 'medium', 'high', 'next message']) assert.ok(provider.includes(term), term);
  assert.doesNotMatch(provider, /Archon does not start/);
  const memory = section('strata-memory');
  for (const term of ['mixture of experts', '24 GiB', '36 GiB', '262144', '32768', 'PLE', 'tok/s']) assert.ok(memory.includes(term), term);
  assert.match(section('strata-recovery'), /FREE VRAM.*unloads loopback/);
  for (const id of ['provider-strata', 'strata-memory', 'strata-recovery']) {
    const html = renderToStaticMarkup(createElement('article', null, MANUAL_SECTIONS.find(s => s.id === id)!.body));
    assert.match(html, /Open docs\/STRATA.md/);
  }
  const root = resolve(process.cwd());
  const doc = readFileSync(resolve(root, 'docs/STRATA.md'), 'utf8');
  for (const match of doc.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^https?:/.test(match[1])) continue;
    assert.ok(existsSync(resolve(root, 'docs', match[1].split('#')[0])), match[1]);
  }
  assert.match(readFileSync(resolve(root, 'client/src/components/SettingsPanel.tsx'), 'utf8'), /data-help="settings.strata-endpoint"/);
  assert.match(readFileSync(resolve(root, 'client/src/components/GenerationSpeedReadout.tsx'), 'utf8'), /data-help="composer.footer.speed"/);
});


test('DeepSeek help explains runtime, routing, memory, guards and version limits', () => {
  const text = section('deepseek');
  for (const term of ['Xolotl', 'Exact', 'Light', '0.25 / 0.15', '262,144', '48 GiB', '64 GiB', 'miner', 'checkout', 'Incognito', 'fork', 'Strata-DSV4.1', 'UP TO DATE']) assert.ok(text.includes(term), term);
  assert.equal(HELP_CONTENT['settings.deepseek'].manualSection, 'deepseek');
  assert.equal(HELP_CONTENT['header.xolotl-version'].manualSection, 'deepseek');
});
