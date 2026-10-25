// ARCO_* environment aliases. Arco keeps Archon's internal ARCHON_* variable
// names so saved state, service units and tooling stay compatible between the
// two. Any ARCO_<NAME> set in the environment takes precedence over
// ARCHON_<NAME> and is copied onto it here, before any other module reads
// process.env. Imported for its side effect as the first line of each server
// entry point; child processes inherit the resolved values.
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('ARCO_') && key.length > 5 && value !== undefined) {
    process.env[`ARCHON_${key.slice(5)}`] = value;
  }
}

export {};
