import { withFileLock } from './atomicFile.js';

// Shared by skill-file edits and whole-folder operations, across both scopes.
export function withSkillMutation<T>(fn: () => Promise<T>): Promise<T> {
  return withFileLock('skill-mutations', fn);
}
