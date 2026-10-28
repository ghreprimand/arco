import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SETTINGS_PAGES, SETTINGS_SECTIONS, settingsHash, settingsMatches, settingsSection } from './navigation.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const panel = read('../SettingsPanel.tsx');
const help = read('../../help/content/settings.tsx');
const map = read('../../../../docs/SETTINGS.md');
const LAYOUT_KEYS = new Set(['settings.navigation', 'settings.scope']);

test('every Settings help entry belongs to exactly one section', () => {
  const keys = [...help.matchAll(/^ {2}'(settings\.[a-z-]+)':/gm)].map((m) => m[1]).filter((k) => !LAYOUT_KEYS.has(k));
  assert.equal(keys.length, 30);
  assert.ok(!keys.includes('settings.zai-api-key'));
  for (const key of keys) assert.equal(SETTINGS_SECTIONS.filter((s) => s.help.includes(key)).length, 1, key);
  for (const s of SETTINGS_SECTIONS) for (const key of s.help) assert.ok(keys.includes(key), `${s.id} help ${key} exists`);
});

test('the dialog renders every section once and nothing outside a section', () => {
  const rendered = [...panel.matchAll(/<SettingsSection id="([a-z-]+)">/g)].map((m) => m[1]);
  assert.deepEqual([...rendered].sort(), SETTINGS_SECTIONS.map((s) => s.id).sort());
  assert.equal(new Set(SETTINGS_SECTIONS.map((s) => s.id)).size, SETTINGS_SECTIONS.length);
  for (const s of SETTINGS_SECTIONS) {
    assert.ok(SETTINGS_PAGES.some((p) => p.id === s.page), s.id);
    assert.match(s.scope, /^(Global|Project|Workflow)\b/, `${s.id} scope label`);
  }
  for (const p of SETTINGS_PAGES) assert.ok(SETTINGS_SECTIONS.some((s) => s.page === p.id), `${p.id} has a section`);
});

test('docs/SETTINGS.md maps every section, with a count that matches', () => {
  const rows = [...map.matchAll(/^\| `([a-z-]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \|/gm)];
  assert.equal(rows.length, SETTINGS_SECTIONS.length);
  assert.equal(Number(/^Sections: (\d+)\.$/m.exec(map)?.[1]), SETTINGS_SECTIONS.length);
  for (const [, id, category, label, scope] of rows) {
    const s = SETTINGS_SECTIONS.find((x) => x.id === id);
    assert.ok(s, id);
    assert.equal(category.trim(), SETTINGS_PAGES.find((p) => p.id === s.page)!.label, `${id} category`);
    assert.equal(label.trim(), s.label, `${id} label`);
    assert.equal(scope.trim(), s.scope, `${id} scope`);
  }
});

test('requests from Connections, the outage banner and old help keys resolve', () => {
  for (const id of ['authentication', 'codex-profiles', 'ollama', 'lmstudio', 'strata-endpoint', 'llamacpp-catalog', 'deepseek', 'transport-defaults', 'enabled-providers', 'cli-versions', 'endpoint-discovery', 'media-unconfined', 'settings.voice-setup', 'phosphor-softness']) {
    assert.ok(settingsSection(id), id);
  }
  assert.equal(settingsSection('ollama')?.id, 'authentication');
  assert.equal(settingsSection('media-unconfined')?.id, 'media-access');
  assert.equal(settingsSection('nope'), undefined);
});

test('addresses accept only a known category and a section on that category', () => {
  assert.deepEqual(settingsHash('#settings/voice'), { page: 'voice' });
  assert.equal(settingsHash('#settings/voice/voice-setup')?.section?.id, 'voice-setup');
  for (const bad of ['#settings/unknown', '#settings/voice/media-access', '#settings/voice/../files', '#settings/files/media-access?x=1', '#connections/claude']) assert.equal(settingsHash(bad), undefined, bad);
});

test('search needs every word and reads labels, scope, keywords and help', () => {
  const media = settingsSection('media-access')!;
  assert.equal(settingsMatches(media, 'media folders'), true);
  assert.equal(settingsMatches(media, 'global media'), true);
  assert.equal(settingsMatches(media, 'quarantine', () => 'files in quarantine'), true);
  assert.equal(settingsMatches(media, 'media nonexistent'), false);
  assert.equal(settingsMatches(media, '   '), false);
  assert.equal(settingsMatches(settingsSection('authentication')!, 'lm studio'), true);
});
