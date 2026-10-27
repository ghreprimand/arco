const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(version) {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Version components exceed the safe integer range.');
  return parts;
}

export function bumpVersion(current, requested) {
  const parts = parseVersion(current);
  let next;
  if (['major', 'minor', 'patch'].includes(requested)) {
    const index = ['major', 'minor', 'patch'].indexOf(requested);
    next = parts.map((part, i) => i < index ? part : i === index ? part + 1 : 0);
  } else next = parseVersion(requested);
  const firstDifferent = next.findIndex((part, i) => part !== parts[i]);
  if (firstDifferent < 0 || next[firstDifferent] < parts[firstDifferent]) throw new Error('The release version must be newer than the current version.');
  const result = next.join('.');
  parseVersion(result);
  return result;
}

function sections(text) {
  return [...text.matchAll(/^## (.+)\r?$/gm)].map(match => ({ title: match[1], start: match.index, bodyStart: match.index + match[0].length }));
}

export function extractSection(changelog, tag) {
  parseVersion(tag.replace(/^v/, ''));
  const headings = sections(changelog);
  const index = headings.findIndex(heading => heading.title.startsWith(`${tag} - `));
  if (index < 0) throw new Error(`Missing CHANGELOG section for ${tag}.`);
  return changelog.slice(headings[index].start, headings[index + 1]?.start ?? changelog.length).trim() + '\n';
}

export function rollChangelog(changelog, version, date) {
  parseVersion(version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Release date must use YYYY-MM-DD.');
  const headings = sections(changelog);
  const index = headings.findIndex(heading => heading.title === 'Unreleased');
  if (index !== 0 || headings.filter(heading => heading.title === 'Unreleased').length !== 1) throw new Error('CHANGELOG must start with one Unreleased section.');
  const end = headings[index + 1]?.start ?? changelog.length;
  const body = changelog.slice(headings[index].bodyStart, end).trim();
  if (!/^[-*] \S/m.test(body)) throw new Error('Unreleased is empty; add a user-visible change before releasing.');
  if (headings.some(heading => heading.title.startsWith(`v${version} - `))) throw new Error(`CHANGELOG already contains v${version}.`);
  return changelog.slice(0, headings[index].start) + `## Unreleased\n\n## v${version} - ${date}\n\n${body}\n\n` + changelog.slice(end);
}

export function rewriteManifest(text, version) {
  parseVersion(version);
  const manifest = JSON.parse(text);
  manifest.version = version;
  return JSON.stringify(manifest, null, 2) + '\n';
}

export function rewriteLockfile(text, version) {
  parseVersion(version);
  const lock = JSON.parse(text);
  lock.version = version;
  for (const path of ['', 'shared', 'server', 'client']) {
    if (!lock.packages?.[path]) throw new Error(`Missing lockfile workspace: ${path || 'root'}`);
    lock.packages[path].version = version;
  }
  return JSON.stringify(lock, null, 2) + '\n';
}

// The inaugural release already has its notes and package version in the tree.
// It can be tagged once without inventing an empty version bump.
export function initialChangelog(changelog, current, requested) {
  if (current !== '0.1.0' || requested !== current) throw new Error('Only the seeded initial 0.1.0 release can keep its package version.');
  const headings = sections(changelog);
  if (headings.length !== 2 || headings[0].title !== 'Unreleased' || !headings[1].title.startsWith('v0.1.0 - ')) throw new Error('Initial release requires only Unreleased and the seeded v0.1.0 section.');
  if (changelog.slice(headings[0].bodyStart, headings[1].start).trim()) throw new Error('Initial release requires an empty Unreleased section; review pending changes before tagging.');
  if (!/^[-*] \S/m.test(extractSection(changelog, 'v0.1.0'))) throw new Error('Initial release notes are empty.');
  return changelog;
}
