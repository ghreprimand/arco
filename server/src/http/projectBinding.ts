import { FileAccessError, safeDirectory } from '../fileAccessPolicy.js';
import { resolveBoundCwd } from './writeConfinement.js';

export async function requireProjectBinding(cwd?: string | null, workflowId?: string | null): Promise<string> {
  const bound = await resolveBoundCwd(cwd, workflowId);
  if (!bound.ok) throw new FileAccessError();
  return safeDirectory(bound.cwd);
}
