// Shared data types for the GitHub panel: the internal view state machine
// and the GH API response shapes. All data flows through the server's
// /api/github/* passthrough which uses `gh auth token` transparently.

export type RepoTab = 'code' | 'pulls' | 'issues' | 'runs' | 'branches' | 'commits';

export type View =
  | { kind: 'repos' }
  | { kind: 'repo'; owner: string; name: string; tab?: RepoTab; initialRef?: string }
  | { kind: 'pull'; owner: string; name: string; number: number }
  | { kind: 'issue'; owner: string; name: string; number: number }
  | { kind: 'run'; owner: string; name: string; id: number }
  // Commit-detail-with-diff (I4). `refName` is the ref we navigated from so
  // Back returns to the right commits list. Metadata (message/author/date) is
  // carried from the list row we clicked so the detail view can render the
  // header without a second commit-metadata fetch (the files come from the
  // commit-detail endpoint).
  | { kind: 'commit'; owner: string; name: string; sha: string; refName: string; message: string; authorName: string; date: string; htmlUrl: string };

export interface GhUser { login: string; name?: string; avatar_url: string; html_url: string; bio?: string; public_repos: number; followers: number; following: number }
export interface GhRepo { id: number; full_name: string; name: string; owner: { login: string; avatar_url: string }; description?: string | null; homepage?: string | null; topics?: string[]; private: boolean; fork: boolean; archived: boolean; language?: string | null; stargazers_count: number; forks_count: number; open_issues_count: number; subscribers_count?: number; watchers_count?: number; default_branch: string; updated_at: string; pushed_at: string; html_url: string; clone_url?: string; ssh_url?: string }
export interface GhPullShort { number: number; title: string; state: string; draft: boolean; merged_at: string | null; user: { login: string; avatar_url: string }; updated_at: string; html_url: string; head: { ref: string; sha: string }; base: { ref: string } }
export interface GhPull extends GhPullShort { body: string | null; additions: number; deletions: number; changed_files: number; merged: boolean; mergeable: boolean | null; mergeable_state: string; commits: number }
export interface GhIssueShort { number: number; title: string; state: string; user: { login: string; avatar_url: string }; comments: number; updated_at: string; labels: Array<{ name: string; color: string }>; html_url: string }
export interface GhIssue extends GhIssueShort { body: string | null }
export interface GhComment { id: number; user: { login: string; avatar_url: string }; body: string; created_at: string; html_url: string }
export interface GhCheckRun { id: number; name: string; status: string; conclusion: string | null; html_url: string }
export interface GhWorkflowRun { id: number; name: string | null; display_title: string; status: string; conclusion: string | null; event: string; head_branch: string; run_number: number; created_at: string; html_url: string; actor: { login: string; avatar_url: string } }
export interface GhWorkflowJob { id: number; name: string; status: string; conclusion: string | null; started_at: string; completed_at: string | null; html_url: string; steps?: Array<{ name: string; status: string; conclusion: string | null; number: number }> }
export interface GhPullFile { sha: string; filename: string; status: string; additions: number; deletions: number; changes: number; patch?: string; previous_filename?: string; blob_url?: string }
export interface GhBranch { name: string; commit: { sha: string }; protected: boolean }
export interface GhTreeEntry { type: 'file' | 'dir'; name: string; path: string; size?: number; sha: string; download_url?: string | null }
export interface GhFileContent { type: 'file'; name: string; path: string; size: number; sha: string; encoding: 'base64' | 'none'; content: string; download_url: string | null; html_url: string }
export interface GhReadme { name: string; path: string; content: string; encoding: string; html_url: string }
export interface GhCommitShort { sha: string; commit: { message: string; author: { name: string; email: string; date: string }; committer: { name: string; email: string; date: string } }; author: { login: string; avatar_url: string } | null; html_url: string }
export interface GhRelease { id: number; tag_name: string; name: string | null; body: string | null; draft: boolean; prerelease: boolean; published_at: string | null; author: { login: string; avatar_url: string }; html_url: string }
export interface GhContributor { login: string; avatar_url: string; contributions: number; html_url: string }
export interface GhTag { name: string; commit: { sha: string } }
