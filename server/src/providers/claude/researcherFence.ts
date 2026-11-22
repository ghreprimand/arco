/** CLI-only policy; callers must also apply and verify the outer OS sandbox. */
export function claudeResearcherFence(options: { webAccess: boolean; webProxyPort: number }): { args: string[] } {
  if (!Number.isInteger(options.webProxyPort) || options.webProxyPort < 1 || options.webProxyPort > 65535) {
    throw new Error('A valid sandbox proxy port is required.');
  }
  const tools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];
  if (options.webAccess) tools.push('WebSearch', 'WebFetch');
  const settings = {
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
      denyInsteadOfPrompting: true,
      allow: ['Bash(*)', 'Read(//work/**)', 'Edit(//work/**)', 'mcp__arco-cluster__peer_read', 'mcp__arco-cluster__peer_send'],
      deny: ['Read(//home/**)', 'Edit(//home/**)', 'Read(//run/arco-access.json)', 'Read(//run/arco-check.json)'],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: ['/home/worker', '/run/arco-access.json', '/run/arco-check.json'], allowRead: ['/work'] },
      network: { httpProxyPort: options.webProxyPort, allowUnixSockets: ['/run/arco-mail.sock'] },
    },
  };
  return { args: ['--permission-mode', 'dontAsk', '--tools', tools.join(','), '--settings', JSON.stringify(settings), '--strict-mcp-config'] };
}
