import { realpathSync } from 'node:fs';
import { findDiagnosticExecutable } from '../../diagnostics/executableLookup.js';
import { basename, dirname } from 'node:path';

// The fenced Cursor transport depends on behaviour seen in this release and
// later: print mode applies Cursor's sandbox, the sandbox helper maps its own
// namespace when the ID-map helpers are absent, and settings come from
// CURSOR_CONFIG_DIR. Cursor updates itself, so an exact version would stop
// research after every update; the self-check before each turn is the guard
// that fails closed when a later release changes that behaviour.
export const ISOLATED_CURSOR_MIN_VERSION = '2026.11.22';

/** The release date of a Cursor install, read from its versioned runtime folder. */
export function installedCursorRuntimeVersion(binary: string): string {
  try {
    const match = /^(\d{4}\.\d{2}\.\d{2})-[0-9a-f]+$/.exec(basename(dirname(realpathSync(binary))));
    return match?.[1] ?? 'unknown';
  } catch { return 'unknown'; }
}

export function cursorIsolationVersionReason(version: string): string | undefined {
  if (/^\d{4}\.\d{2}\.\d{2}$/.test(version) && version >= ISOLATED_CURSOR_MIN_VERSION) return undefined;
  return version === 'unknown'
    ? `Sandboxed Cursor needs Cursor ${ISOLATED_CURSOR_MIN_VERSION} or later; the installed version could not be determined.`
    : `Sandboxed Cursor needs Cursor ${ISOLATED_CURSOR_MIN_VERSION} or later; ${version} is installed.`;
}

/** Why sandboxed Cursor cannot be offered on this installation, if it cannot. */
export function cursorIsolationReason(): string | undefined {
  const binary = findDiagnosticExecutable('cursor-agent');
  if (!binary) return 'Sandboxed Cursor needs the Cursor agent installed.';
  return cursorIsolationVersionReason(installedCursorRuntimeVersion(binary));
}
