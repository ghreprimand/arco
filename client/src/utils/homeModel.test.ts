import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClusterStatePayload, SessionInfo, WorkflowConfig } from '@arco/shared';
import type { JobState } from '../stores/appStore.types';
import { groupProjects, openWork, organizationAvailable, parseProjects, parseSavedSessions, pathWithin, projectLabels, savedSessionRows, scanFolderOf, searchProjects, workForProject, type HomeProject } from './homeModel';

// Synthetic paths only.
const job = (id: string, config: Partial<WorkflowConfig>, extra: Partial<JobState> = {}, at = 0) => ({
  id, config: { name: id, workingDirectory: '', ...config } as WorkflowConfig,
  messages: at ? [{ id: 'm', role: 'system', content: '', isStreaming: false, timestamp: at }] : [],
  ...extra,
}) as unknown as JobState;
const cluster = (clusterId: string, cwd: string, members: string[], name?: string) =>
  ({ clusterId, cwd, members: members.map((workflowId) => ({ workflowId })), ...(name ? { name } : {}) }) as unknown as ClusterStatePayload;
const project = (path: string, source: HomeProject['source'] = 'registered', exists = true): HomeProject =>
  ({ path, name: path.split('/').pop()!, source, exists });

test('the project list is parsed defensively', () => {
  assert.equal(parseProjects(null), null);
  assert.equal(parseProjects({ projects: 'x' }), null);
  assert.deepEqual(parseProjects({ projects: [
    { path: '/projects/app', name: 'app', source: 'registered', exists: true },
    { path: '/projects/app', name: 'dup', source: 'recent', exists: true },
    { path: 'relative', name: 'r', source: 'registered', exists: true },
    { path: '/projects/x', name: 'x', source: 'other', exists: true },
    { path: '/projects/lib', name: '', source: 'scanned' },
    null,
  ] }), [
    { path: '/projects/app', name: 'app', source: 'registered', exists: true },
    { path: '/projects/lib', name: 'lib', source: 'scanned', exists: false },
  ]);
});

test('search matches name or folder; groups keep source order and drop empty groups', () => {
  const list = [project('/projects/web-app'), project('/srv/tools/cli', 'scanned'), project('/data/notes', 'recent')];
  assert.deepEqual(searchProjects(list, '  WEB ').map((p) => p.path), ['/projects/web-app']);
  assert.deepEqual(searchProjects(list, 'srv/').map((p) => p.path), ['/srv/tools/cli']);
  assert.equal(searchProjects(list, '').length, 3);
  assert.deepEqual(groupProjects(list).map((g) => g.key), ['registered', 'recent', 'scanned']);
  assert.deepEqual(groupProjects([list[1]]).map((g) => g.title), ['Found in the projects folder']);
});

test('path containment is by folder boundary, not string prefix', () => {
  assert.ok(pathWithin('/projects/app', '/projects/app'));
  assert.ok(pathWithin('/projects/app/sub', '/projects/app/'));
  assert.ok(!pathWithin('/projects/app-two', '/projects/app'));
  assert.ok(pathWithin('/anything', '/'));
});

test('open work never lists Incognito tabs, cluster members or hidden task children', () => {
  const jobs = {
    a: job('a', { workingDirectory: '/projects/app' }, {}, 10),
    secret: job('secret', { workingDirectory: '/projects/app', incognito: true }, {}, 99),
    chat: job('chat', { kind: 'chat' }, {}, 5),
    member: job('member', { workingDirectory: '/projects/app' }, {}, 50),
    child: job('child', { workingDirectory: '/projects/app' }, { parentWorkflowId: 'a' }),
    promoted: job('promoted', { workingDirectory: '/projects/app' }, { parentWorkflowId: 'a', promoted: true }, 1),
  };
  const items = openWork(jobs, { c1: cluster('c1', '/projects/app', ['member'], 'Team') });
  assert.deepEqual(items.map((i) => `${i.kind}:${i.id}`), ['cluster:c1', 'workflow:a', 'chat:chat', 'workflow:promoted']);
  assert.equal(items[0].name, 'Team');
  assert.equal(items[0].lastActivity, 50, 'a cluster sorts by its newest member activity');
  assert.ok(!JSON.stringify(items).includes('secret'));
});

test('open work belongs to the most specific listed project', () => {
  const all = [project('/projects'), project('/projects/app'), project('/projects/app-two')];
  const work = openWork({
    a: job('a', { workingDirectory: '/projects/app/src' }),
    b: job('b', { workingDirectory: '/projects/other' }),
    c: job('c', { workingDirectory: '/projects/app-two' }),
  }, {});
  assert.deepEqual(workForProject(all[1], all, work).map((w) => w.id), ['a']);
  assert.deepEqual(workForProject(all[0], all, work).map((w) => w.id), ['b']);
  assert.deepEqual(workForProject(all[2], all, work).map((w) => w.id), ['c']);
});

test('saved sessions offer Open for a tab already open and never treat Incognito as open', () => {
  const sessions = [
    { sessionId: 's1', cwd: '/projects/app', name: 'first turn', startedAt: 1, provider: 'claude', arcoWorkflowId: 'a', arcoName: 'Refactor' },
    { sessionId: 's2', cwd: '/projects/app', name: 'other', startedAt: 3, provider: 'codex', providerAccountShortLabel: 'work' },
    { sessionId: 's3', cwd: '/projects/app', name: '', arcoName: 'hidden', startedAt: 2, provider: 'claude', arcoWorkflowId: 'secret' },
  ] as SessionInfo[];
  const rows = savedSessionRows(sessions, { a: job('a', {}), secret: job('secret', { incognito: true }) });
  assert.deepEqual(rows.map((r) => [r.sessionId, r.title, r.openWorkflowId ?? null, r.account ?? null]), [
    ['s2', 'other', null, 'work'],
    ['s3', 'hidden', null, null],
    ['s1', 'first turn', 'a', null],
  ]);
});

test('a refused or malformed saved-session reply is a retryable error, never "no saved sessions"', () => {
  const ok = { sessions: [{ sessionId: 's1', provider: 'claude' }, null, 'x', { sessionId: 7 }, { provider: 'codex' }] };
  assert.deepEqual(parseSavedSessions(200, ok), { sessions: [{ sessionId: 's1', provider: 'claude' }] });
  assert.deepEqual(parseSavedSessions(200, { sessions: [] }), { sessions: [] }, 'only a real empty list is empty');
  for (const status of [401, 403, 404, 500, 503]) {
    const r = parseSavedSessions(status, { sessions: [] });
    assert.ok('error' in r && r.error.includes(String(status)), `HTTP ${status} is an error even with a sessions body`);
  }
  for (const body of [null, undefined, 'text', [], {}, { sessions: null }, { sessions: {} }, { sessions: 'a' }]) {
    assert.ok('error' in parseSavedSessions(200, body), `malformed ${JSON.stringify(body)} is an error`);
  }
});

const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
test('organization fields are parsed only when well formed', () => {
  const [p] = parseProjects({ projects: [{
    path: '/projects/app', name: 'Budget', source: 'scanned', exists: true, id: ID, derivedName: 'app', displayName: 'Budget',
    pinned: true, archived: 'no', previousPaths: ['/old/app', 'relative', 4],
  }] })!;
  assert.deepEqual(p, { path: '/projects/app', name: 'Budget', source: 'scanned', exists: true, id: ID, derivedName: 'app', displayName: 'Budget', pinned: true, previousPaths: ['/old/app'] });
  assert.equal(parseProjects({ projects: [{ path: '/p', name: 'p', source: 'registered', exists: true, id: '../x' }] })![0].id, undefined);
  assert.equal(organizationAvailable({ projects: [], organization: true }), true);
  assert.equal(organizationAvailable({ projects: [] }), false, 'an older server offers no organization');
  assert.equal(scanFolderOf({ scanFolder: '/projects' }), '/projects');
  assert.equal(scanFolderOf({ scanFolder: '' }), null);
});

test('pinned projects lead, archived ones only appear when asked for', () => {
  const list: HomeProject[] = [
    { ...project('/projects/a'), pinned: true },
    project('/projects/b', 'scanned'),
    { ...project('/projects/c', 'recent'), archived: true, pinned: true },
    project('/projects/d'),
  ];
  assert.deepEqual(groupProjects(list).map((g) => [g.key, g.projects.map((p) => p.path)]), [
    ['pinned', ['/projects/a']], ['registered', ['/projects/d']], ['scanned', ['/projects/b']],
  ]);
  assert.deepEqual(groupProjects(list, true).map((g) => g.key), ['pinned', 'registered', 'scanned', 'archived']);
});

test('shared names get the parent folder; renamed projects stay findable by folder name', () => {
  const labels = projectLabels([project('/work/one/app'), project('/work/two/app'), project('/work/site')]);
  assert.deepEqual([...labels.values()], ['app  /  one', 'app  /  two', 'site']);
  const renamed = { ...project('/projects/app'), name: 'Budget', derivedName: 'tally' };
  assert.equal(searchProjects([renamed], 'tally').length, 1);
});

test('work under a previous location stays with the relocated project', () => {
  const moved = { ...project('/projects/app-2026'), previousPaths: ['/old/app'] };
  const items = openWork({ a: job('a', { workingDirectory: '/old/app/src' }, {}, 1), b: job('b', { workingDirectory: '/old/other' }, {}, 1) }, {});
  assert.deepEqual(workForProject(moved, [moved], items).map((i) => i.id), ['a']);
});

test('Windows drive and share projects parse and match open work with native separators', () => {
  const drive = ['R:', 'work', 'app'].join('\\');
  const share = ['','', 'fixture-share', 'projects', 'app'].join('\\');
  const parsed = parseProjects({ projects: [drive, share].map((path) => ({ path, name: 'app', source: 'registered', exists: true })) });
  assert.equal(parsed?.length, 2);
  assert.equal(scanFolderOf({ scanFolder: drive }), drive);
  assert.equal(pathWithin(drive.toUpperCase() + '\\nested', drive), true);
  assert.equal(pathWithin(drive + '-other', drive), false);
  assert.equal(pathWithin(share + '\\nested', share), true);
  assert.equal(pathWithin(share + '-other', share), false);
});

test('named roots separate saved cards from discovery, keep missing roots and one-offs identifiable', () => {
  const roots = [{ name: 'Work', path: '/work', exists: true }, { name: 'Personal', path: '/personal', exists: true }, { name: 'Offline', path: '/offline', exists: false }];
  const list = [{ ...project('/work/app'), rootPath: '/work', pinned: true }, { ...project('/personal/notes', 'recent'), rootPath: '/personal' }, project('/other/site'), ...Array.from({ length: 151 }, (_, i) => ({ ...project(`/work/folder-${i}`, 'scanned'), rootPath: '/work' }))];
  const groups = groupProjects(list, false, roots);
  assert.deepEqual(groups.map(g => g.title), ['Pinned', 'Work', 'Personal', 'Offline', 'Other projects']);
  assert.equal(groups[1].projects.length, 0);
  assert.equal(groups[1].discovered?.length, 151);
  assert.equal(groups[3].exists, false);
  assert.equal(groups.flatMap(g => g.projects).length, 3, 'discoveries never inflate saved cards');
  const search = groupProjects(searchProjects(list, 'folder-150'), false, roots);
  assert.equal(search[0].title, 'Work'); assert.equal(search[0].discovered?.length, 1);
});
