import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ArchonSettings } from '@archon/shared';
import { useAppStore } from '../../client/src/stores/appStore';
import {
  MAX_MEDIA_ROOTS, MEDIA_ACCESS_SUMMARY, MediaAccessSettings, addMediaRoot, mediaAccessState, saveMediaAccess, validateMediaRoot,
} from '../../client/src/components/MediaAccessSettings';
(globalThis as any).React = React;

function render(media: Pick<ArchonSettings, 'mediaUnconfined' | 'mediaAllowedRoots'> | null): string {
  const initial = useAppStore.getInitialState();
  const previous = initial.settings;
  initial.settings = media as ArchonSettings | null;
  try { return renderToStaticMarkup(<MediaAccessSettings />); } finally { initial.settings = previous; }
}

test('undefined settings are confined, never open', () => {
  assert.equal(mediaAccessState(undefined), 'confined');
  assert.equal(mediaAccessState(null), 'confined');
  assert.equal(mediaAccessState({}), 'confined');
  const html = render(null);
  assert.match(html, /data-media-access-state="confined"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /OUTSIDE-FOLDER ACCESS OFF/);
  assert.match(html, /No allowed folders/);
});

test('the legacy boolean alone is shown as granting nothing', () => {
  assert.equal(mediaAccessState({ mediaUnconfined: true }), 'switch-only');
  assert.equal(mediaAccessState({ mediaUnconfined: true, mediaAllowedRoots: [] }), 'switch-only');
  const html = render({ mediaUnconfined: true });
  assert.match(html, /data-media-access-state="switch-only"/);
  assert.match(html, /nothing outside the workflow folder is reachable/);
  assert.match(MEDIA_ACCESS_SUMMARY['switch-only'], /no longer applies/);
});

test('listed folders need the switch; both together allow them', () => {
  assert.equal(mediaAccessState({ mediaAllowedRoots: ['/media'] }), 'folders-off');
  assert.equal(mediaAccessState({ mediaUnconfined: false, mediaAllowedRoots: ['/media'] }), 'folders-off');
  assert.equal(mediaAccessState({ mediaUnconfined: true, mediaAllowedRoots: ['/media'] }), 'allowed');
  const html = render({ mediaUnconfined: true, mediaAllowedRoots: ['/media/library', '/srv/clips'] });
  assert.match(html, /data-media-access-state="allowed"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /aria-label="Remove allowed folder \/media\/library"/);
  assert.match(html, /aria-label="Remove allowed folder \/srv\/clips"/);
  assert.match(html, /REVOKE ALL/);
});

test('the editor is labelled and explains server paths, Docker and blocked folders', () => {
  const html = render(null);
  const id = /<input id="([^"]+)"/.exec(html)?.[1];
  assert.ok(id);
  assert.match(html, new RegExp(`<label for="${id}"[^>]*>Allowed folder \\(absolute path on the Arco server\\)</label>`));
  assert.match(html, /aria-describedby="[^"]+"/);
  assert.match(html, /<ul aria-label="Allowed media folders"/);
  assert.match(html, /role="status"/);
  assert.match(html, /inside the container/);
  assert.match(html, /Provider accounts, credentials and\s+system folders stay blocked even if listed/);
  assert.match(html, /takes effect on the next\s+request/);
  assert.match(html, /data-help="settings.media-unconfined"/);
});

test('folder validation rejects relative paths, roots, duplicates and the 33rd folder', () => {
  assert.deepEqual(validateMediaRoot('  /media/library/ ', []), { path: '/media/library' });
  assert.deepEqual(validateMediaRoot('D:\\Media', []), { path: 'D:\\Media' });
  for (const bad of ['', '   ', 'media', './media', '~/media', '/', '//', 'C:\\', 'C:/']) {
    assert.ok('error' in validateMediaRoot(bad, []), bad);
  }
  assert.ok('error' in validateMediaRoot('/media/', ['/media']));
  const full = Array.from({ length: MAX_MEDIA_ROOTS }, (_, i) => `/m/${i}`);
  assert.match((validateMediaRoot('/m/new', full) as { error: string }).error, /At most 32/);
});

function fakeFetch(status: number, body: unknown, seen: unknown[] = []): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body)));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

test('adding sends the explicit list and reports success', async () => {
  const seen: unknown[] = [];
  const result = await addMediaRoot('/srv/clips', ['/media'], fakeFetch(200, { mediaUnconfined: true, mediaAllowedRoots: ['/media', '/srv/clips'] }, seen));
  assert.deepEqual(seen, [{ mediaAllowedRoots: ['/media', '/srv/clips'] }]);
  assert.ok('settings' in result);
  assert.match(result.message, /Added \/srv\/clips/);
});

test('a folder the server drops is reported, not shown as granted', async () => {
  const result = await addMediaRoot('/srv/clips', ['/media'], fakeFetch(200, { mediaAllowedRoots: ['/media'] }));
  assert.ok('error' in result);
  assert.match(result.error, /did not accept \/srv\/clips/);
});

test('save errors keep previous settings and say so', async () => {
  for (const [status, body] of [[400, { error: 'Bad settings.' }], [500, 'not json'], [200, 'not json']] as const) {
    const result = await saveMediaAccess({ mediaUnconfined: true }, 'ok', fakeFetch(status, body));
    assert.ok('error' in result, String(status));
    assert.match(result.error, /^Not saved: .*previous media access settings still apply/);
  }
  const offline = await saveMediaAccess({ mediaUnconfined: true }, 'ok', (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch);
  assert.ok('error' in offline);
  assert.match(offline.error, /Failed to fetch/);
});

test('revocation patches clear the switch and the folder list explicitly', async () => {
  const seen: unknown[] = [];
  const result = await saveMediaAccess({ mediaUnconfined: false, mediaAllowedRoots: [] }, 'revoked', fakeFetch(200, { mediaUnconfined: false, mediaAllowedRoots: [] }, seen));
  assert.deepEqual(seen, [{ mediaUnconfined: false, mediaAllowedRoots: [] }]);
  assert.ok('settings' in result);
  assert.equal(mediaAccessState(result.settings), 'confined');
});

test('Settings uses the bounded editor and no longer defaults media to open', () => {
  const panel = readFileSync(resolve(process.cwd(), 'client/src/components/SettingsPanel.tsx'), 'utf8');
  assert.doesNotMatch(panel, /mediaUnconfined\s*!==\s*false/);
  assert.match(panel, /<MediaAccessSettings \/>/);
  const help = readFileSync(resolve(process.cwd(), 'client/src/help/content/settings.tsx'), 'utf8');
  assert.doesNotMatch(help, /UNCONFINED<\/C> \(default\)/);
  const manual = readFileSync(resolve(process.cwd(), 'client/src/help/manualSections/media.tsx'), 'utf8');
  assert.doesNotMatch(manual, /on by\s+default/);
});
