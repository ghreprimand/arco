/** Ordinary Chat uses the transport with supported config/rules isolation. */
export function effectiveCodexTransport(
  requested: 'exec' | 'appserver',
  chat: boolean,
  computer = false,
): 'exec' | 'appserver' {
  return chat && !computer ? 'exec' : requested;
}
