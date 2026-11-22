/** The outer OS fence is mandatory; this profile is the provider's second layer. */
export const ISOLATED_CODEX_PROFILE = 'arco-isolated';
export function codexIsolatedProfileArgs(mailUrl: string): string[] {
  const url = new URL(mailUrl);
  const loopback = [127, 0, 0, 1].join('.');
  if (url.protocol !== 'http:' || url.hostname !== loopback || !url.port || url.username || url.password
    || !/^\/mcp\/[a-f0-9]{64}$/.test(url.pathname) || url.search || url.hash) throw new Error('Invalid isolated worker mail endpoint.');
  const home = ['', 'home', 'worker'].join('/');
  const filesystem = `{${JSON.stringify('/')}="read",${JSON.stringify(home)}="deny",${JSON.stringify('/run/arco-pass')}="deny",${JSON.stringify('/run/arco-check.json')}="deny",${JSON.stringify('/work')}="write"}`;
  return ['-c', `default_permissions=${JSON.stringify(ISOLATED_CODEX_PROFILE)}`,
    '-c', `permissions.${ISOLATED_CODEX_PROFILE}.filesystem=${filesystem}`,
    '-c', `permissions.${ISOLATED_CODEX_PROFILE}.network.enabled=true`,
    '-c', 'mcp_servers={}', '-c', `mcp_servers.arco-cluster.url=${JSON.stringify(mailUrl)}`,
    '-c', 'mcp_servers.arco-cluster.default_tools_approval_mode=\"approve\"'];
}

/** Refuse a changed profile or extra MCP servers before any model turn. */
export function isExpectedCodexIsolationConfig(value: unknown, mailUrl: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const config = value as Record<string, unknown>;
  if (config.default_permissions !== ISOLATED_CODEX_PROFILE || !config.permissions || typeof config.permissions !== 'object'
    || !config.mcp_servers || typeof config.mcp_servers !== 'object') return false;
  const servers = Object.keys(config.mcp_servers);
  if (servers.length !== 1 || servers[0] !== 'arco-cluster') return false;
  const mail = (config.mcp_servers as Record<string, unknown>)['arco-cluster'] as Record<string, unknown> | undefined;
  if (!mail || mail.url !== mailUrl || mail.default_tools_approval_mode !== 'approve' || mail.enabled === false) return false;
  if (mail.environment_id != null && mail.environment_id !== 'local') return false;
  if (Object.entries(mail).some(([key, entry]) => !['url', 'default_tools_approval_mode', 'enabled', 'environment_id'].includes(key) && entry != null)) return false;
  const profile = (config.permissions as Record<string, unknown>)[ISOLATED_CODEX_PROFILE] as Record<string, unknown> | undefined;
  if (!profile?.filesystem || typeof profile.filesystem !== 'object' || !profile.network || typeof profile.network !== 'object') return false;
  if (Object.entries(profile).some(([key, entry]) => !['filesystem', 'network', 'description'].includes(key) && entry != null)) return false;
  const files = profile.filesystem as Record<string, unknown>;
  const home = ['', 'home', 'worker'].join('/');
  if (files['/'] !== 'read' || files[home] !== 'deny' || files['/run/arco-pass'] !== 'deny' || files['/run/arco-check.json'] !== 'deny' || files['/work'] !== 'write') return false;
  if (Object.entries(files).some(([key, entry]) => !['/', home, '/run/arco-pass', '/run/arco-check.json', '/work'].includes(key) && entry != null)) return false;
  const network = profile.network as Record<string, unknown>;
  return network.enabled === true && Object.entries(network).every(([key, entry]) => key === 'enabled' || entry == null);
}
