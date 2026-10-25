import { useEffect, useMemo, useState } from 'react';
import type {
  GhRepo, GhBranch, GhTreeEntry, GhFileContent, GhReadme, GhCommitShort,
  GhRelease, GhContributor, GhTag,
} from './types';
import {
  Loading, ErrorBox, EmptyBox, Markdown, fmtDate, fmtBytes, detectLang,
  inputStyle, selectChip, mergeBtnStyle, badgeStyle,
} from './shared';

// ── CODE view: branch picker, file tree, file viewer, README ────────────

export function CodeView({ owner, name, repo, ref, onRefChange }: { owner: string; name: string; repo: GhRepo; ref: string; onRefChange: (r: string) => void }) {
  const [path, setPath] = useState('');
  const [filePath, setFilePath] = useState<string | null>(null); // null = directory view
  const [tree, setTree] = useState<GhTreeEntry[] | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [readme, setReadme] = useState<string | null>(null);
  const [branches, setBranches] = useState<GhBranch[] | null>(null);
  const [showBranchMenu, setShowBranchMenu] = useState(false);
  const [branchQuery, setBranchQuery] = useState('');
  const [releases, setReleases] = useState<GhRelease[] | null>(null);
  const [tags, setTags] = useState<GhTag[] | null>(null);
  const [contributors, setContributors] = useState<GhContributor[] | null>(null);
  const [latestCommit, setLatestCommit] = useState<GhCommitShort | null>(null);
  const [languages, setLanguages] = useState<Record<string, number> | null>(null);
  const [showClone, setShowClone] = useState(false);
  const [showGoTo, setShowGoTo] = useState(false);
  const [branchCommitCount, setBranchCommitCount] = useState<number | null>(null);

  const ghBlobBase = `https://github.com/${owner}/${name}/blob/${ref}`;
  const ghRawBase = `https://raw.githubusercontent.com/${owner}/${name}/${ref}`;

  // Reset file viewer when path/ref changes via the tree
  useEffect(() => { setFilePath(null); }, [path, ref]);

  // Load tree at current path + ref
  useEffect(() => {
    setTree(null);
    setTreeError(null);
    const q = new URLSearchParams();
    q.set('ref', ref);
    if (path) q.set('path', path);
    fetch(`/api/github/repos/${owner}/${name}/tree?${q.toString()}`)
      .then((r) => r.ok ? r.json() : r.json().then((j) => Promise.reject(j.error || r.statusText)))
      .then(setTree)
      .catch((e) => setTreeError(String(e)));
  }, [owner, name, ref, path]);

  // Load README only at repo root
  useEffect(() => {
    if (path) { setReadme(null); return; }
    fetch(`/api/github/repos/${owner}/${name}/readme?ref=${encodeURIComponent(ref)}`)
      .then((r) => r.ok ? r.json() : Promise.reject(r.statusText))
      .then((d: GhReadme) => {
        try {
          setReadme(atob(d.content.replace(/\n/g, '')));
        } catch {
          setReadme(null);
        }
      })
      .catch(() => setReadme(null));
  }, [owner, name, ref, path]);

  // Branch picker opens lazily; the list was already prefetched on mount for
  // the sidebar counts, so opening it is instant.

  // Sidebar info — load once
  useEffect(() => {
    fetch(`/api/github/repos/${owner}/${name}/releases`).then((r) => r.ok ? r.json() : []).then(setReleases).catch(() => setReleases([]));
    fetch(`/api/github/repos/${owner}/${name}/contributors`).then((r) => r.ok ? r.json() : []).then(setContributors).catch(() => setContributors([]));
    fetch(`/api/github/repos/${owner}/${name}/tags`).then((r) => r.ok ? r.json() : []).then(setTags).catch(() => setTags([]));
    fetch(`/api/github/repos/${owner}/${name}/languages`).then((r) => r.ok ? r.json() : {}).then(setLanguages).catch(() => setLanguages({}));
    // Branches load lazily when the picker opens, but the branch/tag count
    // next to the picker wants the length up front. Fetch once at mount.
    if (!branches) {
      fetch(`/api/github/repos/${owner}/${name}/branches`).then((r) => r.ok ? r.json() : []).then(setBranches).catch(() => setBranches([]));
    }
  }, [owner, name]);

  // Global `t` shortcut opens Go-to-file. Skip if typing in an input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 't' || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      e.preventDefault();
      setShowGoTo(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Latest commit info at current ref+path
  useEffect(() => {
    const q = new URLSearchParams();
    q.set('sha', ref);
    if (path) q.set('path', path);
    q.set('per_page', '1');
    fetch(`/api/github/repos/${owner}/${name}/commits?${q.toString()}`)
      .then((r) => r.ok ? r.json() : [])
      .then((d: GhCommitShort[]) => setLatestCommit(d?.[0] ?? null))
      .catch(() => setLatestCommit(null));
  }, [owner, name, ref, path]);

  // Total commit count for the active branch (not path-scoped — branch total)
  useEffect(() => {
    setBranchCommitCount(null);
    fetch(`/api/github/repos/${owner}/${name}/commit-count?sha=${encodeURIComponent(ref)}`)
      .then((r) => r.ok ? r.json() as Promise<{ count: number }> : Promise.reject(r.statusText))
      .then((d) => setBranchCommitCount(d.count))
      .catch(() => setBranchCommitCount(null));
  }, [owner, name, ref]);

  const filteredBranches = useMemo(() => {
    if (!branches) return [];
    const q = branchQuery.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, branchQuery]);

  const breadcrumbs = useMemo(() => {
    const out: Array<{ label: string; path: string }> = [{ label: repo.name, path: '' }];
    if (path) {
      const parts = path.split('/');
      parts.forEach((p, i) => out.push({ label: p, path: parts.slice(0, i + 1).join('/') }));
    }
    return out;
  }, [path, repo.name]);

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, position: 'relative' }}>
      {showGoTo && (
        <GoToFileModal owner={owner} name={name} refName={ref} onClose={() => setShowGoTo(false)} onPick={(p) => { setShowGoTo(false); setFilePath(p); }} />
      )}
      {/* Main column */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        {/* Toolbar: branch picker + counts + breadcrumbs */}
        <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--color-border-hairline)', display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowBranchMenu(!showBranchMenu)} style={{ ...selectChip(true), padding: '5px 12px' }}>
              ⌥ {ref} ▾
            </button>
            {showBranchMenu && (
              <div style={branchMenuStyle}>
                <div style={{ padding: '6px', borderBottom: '1px solid var(--color-border-hairline)' }}>
                  <input
                    value={branchQuery}
                    onChange={(e) => setBranchQuery(e.target.value)}
                    placeholder="Filter branches..."
                    autoFocus
                    style={{ ...inputStyle, width: '100%', fontSize: '11px' }}
                  />
                </div>
                <div style={{ maxHeight: '260px', overflowY: 'auto' }}>
                  {branches === null ? <Loading /> : filteredBranches.length === 0 ? <EmptyBox label="NO BRANCHES" /> : filteredBranches.map((b) => (
                    <button
                      key={b.name}
                      onClick={() => { onRefChange(b.name); setShowBranchMenu(false); setBranchQuery(''); setPath(''); setFilePath(null); }}
                      style={{
                        display: 'block', width: '100%', padding: '5px 12px',
                        background: b.name === ref ? 'var(--color-accent-secondary-a08)' : 'transparent',
                        border: 'none', cursor: 'pointer', textAlign: 'left',
                        color: b.name === ref ? 'var(--color-accent-secondary)' : 'var(--color-accent-primary-dim)',
                        fontFamily: 'var(--font-body)', fontSize: '12px',
                        borderBottom: '1px solid var(--color-accent-secondary-a04)',
                      }}
                    >
                      {b.name === repo.default_branch ? '★ ' : '  '}{b.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', letterSpacing: '1px' }}>
            ⑂ {branches?.length ?? '…'} BRANCH{(branches?.length ?? 0) === 1 ? '' : 'ES'}
          </span>
          <span style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', letterSpacing: '1px' }}>
            ⌖ {tags?.length ?? '…'} TAG{(tags?.length ?? 0) === 1 ? '' : 'S'}
          </span>
          <span style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', letterSpacing: '1px' }}>
            ↻ {branchCommitCount ?? '…'} COMMIT{branchCommitCount === 1 ? '' : 'S'}
          </span>
          <button onClick={() => setShowGoTo(true)} title="Go to file (t)" style={selectChip(false)}>
            <span style={{ marginRight: '4px', opacity: 0.7 }}>t</span> GO TO FILE
          </button>
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowClone(!showClone)} data-help="github.clone" style={selectChip(showClone)}>⇣ CLONE ▾</button>
            {showClone && (
              <CloneMenu repo={repo} onClose={() => setShowClone(false)} />
            )}
          </div>
          <div style={{ display: 'flex', gap: '4px', flex: 1, alignItems: 'center', fontFamily: 'var(--font-body)', fontSize: '12px', color: 'var(--color-accent-primary-dim)', overflow: 'hidden' }}>
            {breadcrumbs.map((b, i) => (
              <span key={i} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {i > 0 && <span style={{ color: 'var(--color-fg-muted)' }}>/</span>}
                <button
                  onClick={() => { setPath(b.path); setFilePath(null); }}
                  style={{ background: 'none', border: 'none', color: i === breadcrumbs.length - 1 && !filePath ? 'var(--color-accent-secondary)' : 'var(--color-accent-primary-dim)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', padding: 0 }}
                >
                  {b.label}
                </button>
              </span>
            ))}
            {filePath && (
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ color: 'var(--color-fg-muted)' }}>/</span>
                <span style={{ color: 'var(--color-accent-secondary)' }}>{filePath.split('/').pop()}</span>
              </span>
            )}
          </div>
        </div>

        {/* Latest commit line */}
        {latestCommit && (
          <div style={{ padding: '6px 20px', borderBottom: '1px solid var(--color-border-hairline)', background: 'rgba(0, 8, 4, 0.4)', fontSize: '11px', fontFamily: 'var(--font-body)', color: 'var(--color-accent-primary-dim)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            {latestCommit.author && <img src={latestCommit.author.avatar_url} alt={latestCommit.author.login} style={{ width: '16px', height: '16px', borderRadius: '50%' }} />}
            <span style={{ color: 'var(--color-accent-secondary-dim)', fontFamily: 'var(--font-display)', letterSpacing: '1px', fontSize: '10px' }}>
              {latestCommit.sha.slice(0, 7)}
            </span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {latestCommit.commit.message.split('\n')[0]}
            </span>
            <span style={{ color: 'var(--color-fg-muted)', fontSize: '10px' }}>
              {fmtDate(latestCommit.commit.author.date)}
            </span>
          </div>
        )}

        {/* File or tree */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 20px', minHeight: 0 }}>
          {filePath ? (
            <FileContents
              owner={owner}
              name={name}
              path={filePath}
              refName={ref}
              onBack={() => setFilePath(null)}
              onOpenFile={(p) => setFilePath(p)}
            />
          ) : (
            <>
              {path && (
                <div style={{ marginBottom: '8px' }}>
                  <button
                    onClick={() => setPath(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')}
                    style={mergeBtnStyle}
                  >
                    ◀ BACK
                  </button>
                </div>
              )}
              {treeError && <ErrorBox message={treeError} />}
              {tree === null && !treeError && <Loading />}
              {tree && tree.length === 0 && <EmptyBox label="Empty directory." />}
              {tree && tree.length > 0 && (
                <div style={{ border: '1px solid var(--color-border-hairline)', borderRadius: '4px', overflow: 'hidden', marginBottom: readme ? '16px' : 0 }}>
                  {tree.slice().sort(sortTreeEntries).map((entry) => (
                    <button
                      key={entry.path}
                      onClick={() => {
                        if (entry.type === 'dir') { setPath(entry.path); setFilePath(null); }
                        else setFilePath(entry.path);
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '10px', width: '100%',
                        padding: '6px 12px', background: 'transparent', border: 'none',
                        borderBottom: '1px solid var(--color-accent-primary-a05)',
                        color: entry.type === 'dir' ? 'var(--color-accent-secondary)' : 'var(--color-accent-primary-dim)',
                        cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-body)', fontSize: '12px',
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-accent-secondary-a04)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                    >
                      <span style={{ width: '16px', fontSize: '13px' }}>{entry.type === 'dir' ? '📁' : '📄'}</span>
                      <span style={{ flex: 1 }}>{entry.name}{entry.type === 'dir' ? '/' : ''}</span>
                      {entry.size !== undefined && entry.type === 'file' && (
                        <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)' }}>{fmtBytes(entry.size)}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {readme && !path && (
                <div style={{ border: '1px solid var(--color-border-hairline)', borderRadius: '4px', padding: '16px 20px', background: 'rgba(0, 8, 4, 0.4)' }}>
                  <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '12px', borderBottom: '1px solid var(--color-border-hairline)', paddingBottom: '8px' }}>README.MD</div>
                  <Markdown
                    value={readme}
                    basePath=""
                    ghBlobBase={ghBlobBase}
                    ghRawBase={ghRawBase}
                    onOpenRelative={(p) => setFilePath(p)}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Right sidebar: about / languages / releases / tags / contributors */}
      <div style={{ width: '260px', borderLeft: '1px solid var(--color-border-hairline)', padding: '12px', overflowY: 'auto', flexShrink: 0, background: 'rgba(0, 8, 4, 0.3)' }}>
        <SidebarSection label="ABOUT">
          <div style={{ fontSize: '11px', color: 'var(--color-accent-primary-dim)', lineHeight: 1.5, fontFamily: 'var(--font-body)' }}>
            {repo.description || <span style={{ fontStyle: 'italic', color: 'var(--color-fg-muted)' }}>No description, website, or topics provided.</span>}
          </div>
          {repo.homepage && (
            <div style={{ marginTop: '6px' }}>
              <a href={repo.homepage} target="_blank" rel="noopener noreferrer" style={{ fontSize: '11px', color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-body)', textDecoration: 'none', wordBreak: 'break-all' }}>
                🔗 {repo.homepage.replace(/^https?:\/\//, '')}
              </a>
            </div>
          )}
          {repo.topics && repo.topics.length > 0 && (
            <div style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
              {repo.topics.map((t) => (
                <span key={t} style={{ fontSize: '9px', padding: '2px 7px', border: '1px solid var(--color-accent-secondary-dim)', borderRadius: '10px', color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-display)', letterSpacing: '0.5px', background: 'var(--color-accent-secondary-a06)' }}>
                  {t}
                </span>
              ))}
            </div>
          )}
          <div style={{ marginTop: '10px', fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', letterSpacing: '0.5px', lineHeight: 1.7 }}>
            ★ {repo.stargazers_count} star{repo.stargazers_count === 1 ? '' : 's'}<br />
            👁 {repo.subscribers_count ?? repo.watchers_count ?? 0} watching<br />
            ⑂ {repo.forks_count} fork{repo.forks_count === 1 ? '' : 's'}<br />
            Default · {repo.default_branch}<br />
            Updated · {fmtDate(repo.pushed_at)}
          </div>
        </SidebarSection>

        <SidebarSection label="LANGUAGES">
          <LanguagesBar languages={languages} />
        </SidebarSection>

        <SidebarSection label={`RELEASES${releases && releases.length > 0 ? ` (${releases.length})` : ''}`}>
          {releases === null ? <Loading /> : releases.length === 0 ? <SidebarEmpty label="No releases." /> : (
            releases.slice(0, 5).map((r) => (
              <a key={r.id} href={r.html_url} target="_blank" rel="noopener noreferrer" style={sidebarItemStyle}>
                <div style={{ color: 'var(--color-accent-primary)', fontSize: '11px', fontFamily: 'var(--font-display)', letterSpacing: '1px' }}>
                  {r.tag_name}
                  {r.draft && <span style={{ marginLeft: '6px', ...badgeStyle('amber') }}>DRAFT</span>}
                  {r.prerelease && <span style={{ marginLeft: '6px', ...badgeStyle('amber') }}>PRE</span>}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>{r.published_at ? fmtDate(r.published_at) : 'draft'}</div>
              </a>
            ))
          )}
        </SidebarSection>

        <SidebarSection label={`TAGS${tags && tags.length > 0 ? ` (${tags.length})` : ''}`}>
          {tags === null ? <Loading /> : tags.length === 0 ? <SidebarEmpty label="No tags." /> : (
            <div>
              {tags.slice(0, 10).map((t) => (
                <button
                  key={t.name}
                  onClick={() => { onRefChange(t.name); setPath(''); setFilePath(null); }}
                  title={`Browse at tag ${t.name}`}
                  style={{
                    display: 'flex', width: '100%', padding: '3px 0', background: 'none', border: 'none',
                    cursor: 'pointer', textAlign: 'left', alignItems: 'center', gap: '6px',
                    borderBottom: '1px solid var(--color-accent-secondary-a04)',
                  }}
                >
                  <span style={{ color: 'var(--color-accent-primary)', fontSize: '11px', fontFamily: 'var(--font-display)', letterSpacing: '1px' }}>{t.name}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: '9px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', letterSpacing: '1px' }}>{t.commit.sha.slice(0, 7)}</span>
                </button>
              ))}
              {tags.length > 10 && <div style={{ fontSize: '9px', color: 'var(--color-fg-muted)', marginTop: '4px' }}>+ {tags.length - 10} more</div>}
            </div>
          )}
        </SidebarSection>

        <SidebarSection label={`CONTRIBUTORS${contributors && contributors.length > 0 ? ` (${contributors.length})` : ''}`}>
          {contributors === null ? <Loading /> : contributors.length === 0 ? <SidebarEmpty label="None." /> : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
              {contributors.slice(0, 20).map((c) => (
                <a key={c.login} href={c.html_url} target="_blank" rel="noopener noreferrer" title={`${c.login} — ${c.contributions} contributions`} style={{ display: 'block', width: '24px', height: '24px', borderRadius: '3px', overflow: 'hidden' }}>
                  <img src={c.avatar_url} alt={c.login} style={{ width: '100%', height: '100%', display: 'block' }} />
                </a>
              ))}
            </div>
          )}
        </SidebarSection>
      </div>
    </div>
  );
}

// Canonical-ish language colors lifted from github-linguist (subset; anything
// not in the map falls back to the cyber palette). Matches what GitHub shows
// in the bar chart so the operator's eyes don't need to learn a new mapping.
const LANG_COLORS: Record<string, string> = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5',
  Go: '#00ADD8', Rust: '#dea584', Java: '#b07219', Kotlin: '#A97BFF',
  Swift: '#F05138', C: '#555555', 'C++': '#f34b7d', 'C#': '#178600',
  Ruby: '#701516', PHP: '#4F5D95', Shell: '#89e051', Bash: '#89e051',
  HTML: '#e34c26', CSS: '#563d7c', SCSS: '#c6538c', Less: '#1d365d',
  Vue: '#41b883', Svelte: '#ff3e00', Astro: '#ff5a03',
  Dockerfile: '#384d54', Makefile: '#427819', CMake: '#DA3434',
  YAML: '#cb171e', TOML: '#9c4221', JSON: '#292929', Markdown: '#083fa1',
  Nix: '#7e7eff', Haskell: '#5e5086', OCaml: '#3be133', Elixir: '#6e4a7e',
  Erlang: '#B83998', Lua: '#000080', Perl: '#0298c3', R: '#198CE7',
  Scala: '#c22d40', Dart: '#00B4AB', PowerShell: '#012456', WGSL: '#1a5490',
  TSX: '#3178c6', JSX: '#f1e05a', MDX: '#fcb32c', GraphQL: '#e10098',
  SQL: '#e38c00', Objective: '#438eff', 'Objective-C': '#438eff',
  Zig: '#ec915c', Nim: '#37775b', V: '#4f87c4', Roc: '#7d59df',
};

function LanguagesBar({ languages }: { languages: Record<string, number> | null }) {
  if (languages === null) return <Loading />;
  const entries = Object.entries(languages);
  if (entries.length === 0) return <SidebarEmpty label="No languages detected." />;
  const total = entries.reduce((s, [, n]) => s + n, 0);
  const withPct = entries
    .map(([name, bytes]) => ({ name, bytes, pct: (bytes / total) * 100 }))
    .sort((a, b) => b.bytes - a.bytes);
  return (
    <div>
      <div style={{ display: 'flex', height: '8px', borderRadius: '4px', overflow: 'hidden', marginBottom: '8px', border: '1px solid var(--color-border-hairline)' }}>
        {withPct.map((l) => (
          <div
            key={l.name}
            title={`${l.name} · ${l.pct.toFixed(1)}%`}
            style={{ width: `${l.pct}%`, background: LANG_COLORS[l.name] || 'var(--color-accent-secondary-dim)' }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontFamily: 'var(--font-body)', fontSize: '11px' }}>
        {withPct.slice(0, 6).map((l) => (
          <div key={l.name} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: LANG_COLORS[l.name] || 'var(--color-accent-secondary-dim)', display: 'inline-block', flexShrink: 0 }} />
            <span style={{ color: 'var(--color-accent-primary-dim)' }}>{l.name}</span>
            <span style={{ flex: 1 }} />
            <span style={{ color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', letterSpacing: '0.5px', fontSize: '10px' }}>{l.pct.toFixed(1)}%</span>
          </div>
        ))}
        {withPct.length > 6 && (
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', marginTop: '2px' }}>+ {withPct.length - 6} more</div>
        )}
      </div>
    </div>
  );
}

function FileContents({ owner, name, path, refName, onBack, onOpenFile }: { owner: string; name: string; path: string; refName: string; onBack: () => void; onOpenFile: (path: string) => void }) {
  const [file, setFile] = useState<GhFileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const parentDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const ghBlobBase = `https://github.com/${owner}/${name}/blob/${refName}`;
  const ghRawBase = `https://raw.githubusercontent.com/${owner}/${name}/${refName}`;

  useEffect(() => {
    setFile(null);
    setError(null);
    const q = new URLSearchParams();
    q.set('path', path);
    q.set('ref', refName);
    fetch(`/api/github/repos/${owner}/${name}/contents?${q.toString()}`)
      .then((r) => r.ok ? r.json() : r.json().then((j) => Promise.reject(j.error || r.statusText)))
      .then((d: GhFileContent) => setFile(d))
      .catch((e) => setError(String(e)));
  }, [owner, name, path, refName]);

  const decoded = useMemo(() => {
    if (!file) return null;
    if (file.encoding === 'base64') {
      try {
        const bin = atob(file.content.replace(/\n/g, ''));
        // UTF-8 safe decode
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      } catch { return null; }
    }
    return file.content;
  }, [file]);

  const lang = useMemo(() => file ? detectLang(file.name) : 'text', [file]);
  const isImage = file ? /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(file.name) : false;

  if (error) return <ErrorBox message={error} onDismiss={onBack} />;
  if (!file) return <Loading />;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px', flexWrap: 'wrap' }}>
        <button onClick={onBack} style={mergeBtnStyle}>◀ BACK</button>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: '13px', color: 'var(--color-accent-secondary)' }}>{file.name}</span>
        <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)' }}>{fmtBytes(file.size)}</span>
        {file.download_url && <a href={file.download_url} target="_blank" rel="noreferrer" style={{ fontSize: '10px', color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-display)', letterSpacing: '1px', textDecoration: 'none' }}>RAW ↗</a>}
        <a href={file.html_url} target="_blank" rel="noreferrer" style={{ fontSize: '10px', color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-display)', letterSpacing: '1px', textDecoration: 'none' }}>OPEN ON GH ↗</a>
      </div>
      {isImage && file.download_url ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '16px', background: 'rgba(0, 8, 4, 0.6)', border: '1px solid var(--color-border-hairline)', borderRadius: '4px' }}>
          <img src={file.download_url} alt={file.name} style={{ maxWidth: '100%', maxHeight: '72vh', objectFit: 'contain' }} />
        </div>
      ) : decoded !== null ? (
        lang === 'md' || lang === 'markdown' ? (
          <div style={{ border: '1px solid var(--color-border-hairline)', borderRadius: '4px', padding: '16px 20px', background: 'rgba(0, 8, 4, 0.4)' }}>
            <Markdown
              value={decoded}
              basePath={parentDir}
              ghBlobBase={ghBlobBase}
              ghRawBase={ghRawBase}
              onOpenRelative={onOpenFile}
            />
          </div>
        ) : (
          <div className="archon-markdown" style={{ border: '1px solid var(--color-border-hairline)', borderRadius: '4px', overflow: 'hidden' }}>
            <Markdown value={'```' + lang + '\n' + decoded + '\n```'} />
          </div>
        )
      ) : (
        <div style={{ padding: '20px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', fontSize: '12px', textAlign: 'center' }}>
          (binary or too large to preview)
        </div>
      )}
    </div>
  );
}

// ── Clone menu + Go-to-file modal ───────────────────────────────────────

function CloneMenu({ repo, onClose }: { repo: GhRepo; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const https = repo.clone_url || `https://github.com/${repo.full_name}.git`;
  const ssh = repo.ssh_url || `git@github.com:${repo.full_name}.git`;
  const gh = `gh repo clone ${repo.full_name}`;
  const rows: Array<{ label: string; value: string }> = [
    { label: 'HTTPS', value: https },
    { label: 'SSH', value: ssh },
    { label: 'GH CLI', value: gh },
  ];
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && el.closest('[data-clone-menu]')) return;
      onClose();
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [onClose]);
  return (
    <div data-clone-menu style={{ ...branchMenuStyle, width: '360px', padding: '6px' }}>
      {rows.map((r) => (
        <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
          <span style={{ width: '50px', fontSize: '10px', color: 'var(--color-accent-secondary-dim)', fontFamily: 'var(--font-display)', letterSpacing: '1px' }}>{r.label}</span>
          <input readOnly value={r.value} style={{ ...inputStyle, flex: 1, fontSize: '11px', padding: '4px 6px' }} onFocus={(e) => e.currentTarget.select()} />
          <button
            onClick={() => {
              navigator.clipboard.writeText(r.value).then(() => {
                setCopied(r.label);
                setTimeout(() => setCopied((c) => (c === r.label ? null : c)), 1200);
              }).catch(() => {});
            }}
            style={{ ...selectChip(copied === r.label), padding: '4px 8px', fontSize: '10px' }}
          >
            {copied === r.label ? '✓' : 'COPY'}
          </button>
        </div>
      ))}
    </div>
  );
}

// Simple subsequence fuzzy scorer. Lowercased query chars must appear in
// order; match score rewards density + matches in the basename.
function fuzzyScore(path: string, query: string): number | null {
  if (!query) return 0;
  const p = path.toLowerCase();
  const q = query.toLowerCase();
  let pi = 0;
  let score = 0;
  let lastMatchIdx = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    const found = p.indexOf(c, pi);
    if (found === -1) return null;
    // Bonus for consecutive matches, extra for basename matches.
    const consec = lastMatchIdx === found - 1 ? 5 : 0;
    const base = found > p.lastIndexOf('/') ? 2 : 0;
    score += 10 - Math.min(9, found - pi) + consec + base;
    pi = found + 1;
    lastMatchIdx = found;
  }
  // Shorter paths beat longer ones at equal match quality.
  return score - path.length * 0.05;
}

function GoToFileModal({ owner, name, refName, onClose, onPick }: { owner: string; name: string; refName: string; onClose: () => void; onPick: (path: string) => void }) {
  const [entries, setEntries] = useState<Array<{ path: string; size?: number }> | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    fetch(`/api/github/repos/${owner}/${name}/tree?ref=${encodeURIComponent(refName)}&recursive=1`)
      .then((r) => r.ok ? r.json() : r.json().then((j) => Promise.reject(j.error || r.statusText)))
      .then((d: { entries: Array<{ path: string; size?: number }>; truncated: boolean }) => {
        setEntries(d.entries);
        setTruncated(d.truncated);
      })
      .catch((e) => setError(String(e)));
  }, [owner, name, refName]);

  const results = useMemo(() => {
    if (!entries) return [];
    if (!query.trim()) return entries.slice(0, 200).map((e) => ({ ...e, score: 0 }));
    return entries
      .map((e) => ({ ...e, score: fuzzyScore(e.path, query.trim()) }))
      .filter((e): e is { path: string; size?: number; score: number } => e.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 200);
  }, [entries, query]);

  useEffect(() => { setCursor(0); }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(results.length - 1, c + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
      else if (e.key === 'Enter') {
        const pick = results[cursor];
        if (pick) { e.preventDefault(); onPick(pick.path); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [results, cursor, onClose, onPick]);

  return (
    <div
      onClick={onClose}
      style={{ position: 'absolute', inset: 0, zIndex: 50, background: 'rgba(0, 0, 0, 0.6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '80px' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: '560px', maxWidth: '90%', background: 'var(--color-bg)', border: '1px solid var(--color-accent-secondary-dim)', borderRadius: '4px', boxShadow: '0 10px 40px rgba(0, 0, 0, 0.5)', display: 'flex', flexDirection: 'column', maxHeight: '70vh' }}
      >
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--color-border-hairline)' }}>
          <input
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            placeholder={entries ? `Search ${entries.length} files…` : 'Loading tree…'}
            style={{ ...inputStyle, width: '100%', fontSize: '13px', padding: '6px 8px' }}
          />
          {truncated && (
            <div style={{ marginTop: '4px', fontSize: '10px', color: 'var(--color-warning)', fontFamily: 'var(--font-display)', letterSpacing: '0.5px' }}>
              ⚠ Tree was truncated — very large repo. Not all files are shown.
            </div>
          )}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {error && <ErrorBox message={error} />}
          {!entries && !error && <Loading />}
          {entries && results.length === 0 && <EmptyBox label={query.trim() ? 'No matches.' : 'No files.'} />}
          {results.map((r, i) => (
            <button
              key={r.path}
              onMouseEnter={() => setCursor(i)}
              onClick={() => onPick(r.path)}
              style={{
                display: 'flex', alignItems: 'center', gap: '10px', width: '100%',
                padding: '5px 12px', background: i === cursor ? 'var(--color-accent-secondary-a10)' : 'transparent',
                border: 'none', borderBottom: '1px solid var(--color-accent-primary-a05)',
                color: 'var(--color-accent-primary-dim)', cursor: 'pointer', textAlign: 'left',
                fontFamily: 'var(--font-body)', fontSize: '12px',
              }}
            >
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ color: 'var(--color-accent-secondary)' }}>{r.path.split('/').pop()}</span>
                {r.path.includes('/') && (
                  <span style={{ color: 'var(--color-fg-muted)', marginLeft: '8px', fontSize: '10px' }}>{r.path.slice(0, r.path.lastIndexOf('/'))}</span>
                )}
              </span>
              {r.size !== undefined && <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)' }}>{fmtBytes(r.size)}</span>}
            </button>
          ))}
        </div>
        <div style={{ padding: '4px 10px', borderTop: '1px solid var(--color-border-hairline)', fontSize: '9px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', letterSpacing: '1px', display: 'flex', gap: '12px' }}>
          <span>↑↓ NAVIGATE</span>
          <span>↵ OPEN</span>
          <span>ESC CLOSE</span>
        </div>
      </div>
    </div>
  );
}

// ── Sidebar helpers ─────────────────────────────────────────────────────

function SidebarSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '6px', paddingBottom: '3px', borderBottom: '1px solid var(--color-border-hairline)' }}>
        {label}
      </div>
      {children}
    </div>
  );
}
function SidebarEmpty({ label }: { label: string }) {
  return <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontStyle: 'italic' }}>{label}</div>;
}
const sidebarItemStyle: React.CSSProperties = {
  display: 'block',
  padding: '4px 0',
  textDecoration: 'none',
  borderBottom: '1px solid var(--color-accent-secondary-a04)',
};
const branchMenuStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  left: 0,
  width: '280px',
  background: 'rgba(5, 12, 8, 0.98)',
  border: '1px solid var(--color-accent-secondary)',
  borderRadius: '4px',
  boxShadow: '0 0 18px var(--color-accent-secondary-a20)',
  zIndex: 20,
};

function sortTreeEntries(a: GhTreeEntry, b: GhTreeEntry): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name);
}
