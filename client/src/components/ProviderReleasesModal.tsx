import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/atom-one-dark.css';
import { strataEngineReleaseVersion } from '@arco/shared';

// Shared in-app release/source history for operator-managed runtimes.
// GitHub is an explicit link; opening a version row never opens a browser.
interface Release {
  tag_name: string;
  name: string | null;
  html_url: string;
  published_at: string | null;
  body: string | null;
}

interface Commit { sha: string; html_url: string; commit: { message: string; committer?: { date?: string } } }
interface Comparison { status: string; ahead_by?: number; behind_by?: number; commits?: Commit[] }
export type ReleaseRuntime = 'ollama' | 'strata' | 'xolotl';
const RUNTIMES = { ollama: { label: 'OLLAMA', repo: 'ollama/ollama' }, strata: { label: 'STRATA', repo: 'Niko1221/Strata' }, xolotl: { label: 'XOLOTL', repo: 'Indras-Mirror/Xolotl' } };

interface Props {
  onClose: () => void;
  installedVersion?: string;
  runtime: ReleaseRuntime;
}


function formatDate(iso: string | null): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

export function ProviderReleasesModal({ onClose, installedVersion, runtime }: Props) {
  const { label, repo } = RUNTIMES[runtime];
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const abort = new AbortController();
    setReleases(null); setCommits(null); setComparison(null); setError(null);
    const request = async (path: string) => {
      const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
        headers: { Accept: 'application/vnd.github+json' }, signal: abort.signal,
      });
      if (!response.ok) throw new Error(`GitHub API ${response.status}`);
      return response.json();
    };
    const load = async () => {
      const releaseTask = request('releases?per_page=10').then((data) => {
        if (!Array.isArray(data)) throw new Error('GitHub returned an invalid release list.');
        if (!abort.signal.aborted) setReleases(data);
      });
      if (runtime !== 'xolotl') { await releaseTask; return; }
      const commitTask = request('commits?per_page=10').then(async (data: Commit[]) => {
        if (!Array.isArray(data)) throw new Error('GitHub returned an invalid commit list.');
        if (abort.signal.aborted) return;
        setCommits(data);
        const latest = data[0]?.sha;
        if (!installedVersion || !/^[a-f0-9]{40}$/.test(installedVersion) || !latest || !/^[a-f0-9]{40}$/.test(latest)) return;
        if (latest === installedVersion) { setComparison({ status: 'identical', commits: [] }); return; }
        const compared = await request(`compare/${installedVersion}...${latest}`);
        if (!abort.signal.aborted) setComparison(compared);
      });
      const results = await Promise.allSettled([releaseTask, commitTask]);
      const failed = results.find((r) => r.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    };
    void load().catch((e) => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    return () => abort.abort();
  }, [repo, runtime, installedVersion]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.82)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9500,
        backdropFilter: 'blur(3px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glow-border"
        role="dialog" aria-modal="true" aria-label={`${label} ${runtime === 'xolotl' ? 'changes' : 'releases'}`}
        style={{
          // Frosted token so frosted mode + the opacity slider reach this modal.
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-accent-secondary)',
          borderRadius: '6px',
          width: 'min(820px, 92vw)',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 0 36px var(--color-accent-secondary-a30)',
        }}
      >
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border-hairline)', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span className="display-font" style={{ fontSize: '10px', padding: '2px 6px', border: '1px solid var(--color-accent-secondary)', color: 'var(--color-accent-secondary)', letterSpacing: '2px', borderRadius: '2px' }}>
            {label}
          </span>
          <span className="display-font glow-text" style={{ flex: 1, fontSize: '13px', letterSpacing: '2px', color: 'var(--color-accent-primary)' }}>
            {runtime === 'xolotl' ? 'SOURCE CHANGES' : 'RELEASES'}
          </span>
          {installedVersion && (
            <span className="display-font" style={{ fontSize: '9px', color: 'var(--color-fg-muted)', letterSpacing: '1px' }}>
              {runtime === 'xolotl' ? `checkout ${installedVersion.slice(0, 12)}` : `${runtime === 'strata' ? 'engine' : 'installed'} v${installedVersion}`}
            </span>
          )}
          <button
            onClick={onClose}
            className="display-font"
            style={{
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
              padding: '3px 8px',
            }}
          >
            CLOSE
          </button>
        </div>
        <div style={{ padding: '14px 18px', overflowY: 'auto', flex: 1 }}>
          {!releases && !commits && !error && (
            <div className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '11px', letterSpacing: '1px' }}>
              LOADING…
            </div>
          )}
          {error && (
            <div className="display-font" style={{ color: 'var(--color-warning)', fontSize: '11px', letterSpacing: '1px' }}>
              FAILED: {error}
            </div>
          )}
          {runtime === 'strata' && <p style={{ color: 'var(--color-fg-muted)', fontSize: '12px' }}>App/Terminal and engine versions are separate. Engine updates below are compared with your installed engine; nothing is installed automatically.</p>}
          {runtime === 'xolotl' && comparison && <p role="status" style={{ color: 'var(--color-accent-primary)', fontSize: '12px' }}>{comparison.status === 'identical' ? 'UP TO DATE · installed checkout matches upstream.' : comparison.status === 'ahead' ? `${comparison.ahead_by ?? 0} upstream commits beyond your installed checkout.` : 'Installed and upstream source histories differ; review the changes before updating.'}</p>}
          {runtime === 'xolotl' && <p style={{ color: 'var(--color-fg-muted)', fontSize: '12px' }}>Xolotl is the runtime; DeepSeek is the model. This tracks checkout source, not proof of the binary build revision. Recent upstream commits are listed below.</p>}
          {releases && releases.length === 0 && (
            <div className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '11px', letterSpacing: '1px' }}>
              {runtime === 'xolotl' ? 'No tagged releases; showing source history.' : 'NO RELEASES FOUND.'}
            </div>
          )}
          {releases && releases.map((r) => {
            const tag = r.tag_name.replace(/^v/, '');
            const engine = runtime === 'strata' ? strataEngineReleaseVersion(null, r) : undefined;
            const isInstalled = runtime !== 'xolotl' && installedVersion && (runtime === 'strata' ? engine : tag) === installedVersion;
            return (
              <div
                key={r.tag_name}
                style={{
                  marginBottom: '18px',
                  paddingBottom: '14px',
                  borderBottom: '1px solid var(--color-border-hairline)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '6px' }}>
                  <span
                    className="display-font glow-text"
                    style={{
                      fontSize: '13px',
                      letterSpacing: '2px',
                      color: isInstalled ? 'var(--color-warning)' : 'var(--color-accent-primary)',
                    }}
                  >
                    {runtime === 'strata' && engine ? `engine v${engine} · release v${tag}` : `v${tag}`}
                  </span>
                  {isInstalled && (
                    <span
                      className="display-font"
                      style={{ fontSize: '9px', letterSpacing: '1.5px', color: 'var(--color-warning)' }}
                    >
                      [INSTALLED]
                    </span>
                  )}
                  <span
                    className="display-font"
                    style={{ fontSize: '10px', color: 'var(--color-fg-muted)', letterSpacing: '1px' }}
                  >
                    {formatDate(r.published_at)}
                  </span>
                  <a
                    href={r.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="display-font"
                    style={{
                      marginLeft: 'auto',
                      fontSize: '9px',
                      letterSpacing: '1px',
                      color: 'var(--color-accent-secondary)',
                      textDecoration: 'none',
                      border: '1px solid var(--color-accent-secondary)',
                      borderRadius: '3px',
                      padding: '2px 6px',
                    }}
                  >
                    GITHUB ↗
                  </a>
                </div>
                <div className="markdown-body" style={{ fontSize: '12px', color: 'var(--color-fg-default)', lineHeight: 1.5 }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a> }}>
                    {r.body || '_(no release notes)_'}
                  </ReactMarkdown>
                </div>
              </div>
            );
          })}
          {runtime === 'xolotl' && commits && <div>
            <h3 className="display-font" style={{ color: 'var(--color-accent-primary)' }}>RECENT SOURCE COMMITS</h3>
            {(comparison?.status === 'ahead' && comparison.commits?.length ? [...comparison.commits].reverse() : commits).map((c) => <div key={c.sha} style={{ padding: '10px 0', borderBottom: '1px solid var(--color-border-hairline)' }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
                <code>{c.sha.slice(0, 12)}</code><small>{c.commit?.committer?.date?.slice(0, 10)}</small>
                {c.sha === installedVersion && <small>[INSTALLED CHECKOUT]</small>}
                <a href={c.html_url} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 'auto' }}>GITHUB ↗</a>
              </div>
              <p style={{ whiteSpace: 'pre-wrap', fontSize: '12px' }}>{c.commit?.message}</p>
            </div>)}
          </div>}
        </div>
      </div>
    </div>
  );
}
