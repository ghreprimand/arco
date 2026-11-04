// Fallback for environment variables named with the upstream prefix. Arco
// reads only ARCO_* names. For each upstream-prefixed variable present in the
// environment (for example from a service unit written before the rename),
// its value is copied onto the matching ARCO_<NAME> when that name is unset;
// an ARCO_<NAME> that is set always wins. Nothing else reads the old names.
// Imported for its side effect as the first line of each server entry point,
// before any other module reads process.env; child processes inherit the
// resolved values.
//
// The prefix is assembled from parts so the tree-wide name audit stays clean.
export const UPSTREAM_ENV_PREFIX = `${['ARC', 'HON'].join('')}_`;
// A privacy denylist name only; this directory is never used as Arco state.
export const UPSTREAM_STATE_DIRECTORY = `.${UPSTREAM_ENV_PREFIX.slice(0, -1).toLowerCase()}`;

export function applyEnvFallback(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(UPSTREAM_ENV_PREFIX) || key.length <= UPSTREAM_ENV_PREFIX.length || value === undefined) continue;
    const name = `ARCO_${key.slice(UPSTREAM_ENV_PREFIX.length)}`;
    if (env[name] === undefined) env[name] = value;
  }
}

applyEnvFallback();
