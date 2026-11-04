// docs/PROVIDERS.md - grep / rg filter pack.
//
// Same shape as find: line-per-match. Cap from the head; on a failed
// match (exit 1 from grep === no matches found, which is normal — we
// don't switch to tail there). Real errors (exit ≥ 2 for grep, exit 2
// for rg config errors) flip to tail via branch_on_exit, but exit 1 we
// treat as success since the no-matches output is tiny anyway.

import type { FilterPack } from '../filterToolResult.js';

export const bashGrep: FilterPack = {
  name: 'grep-head-cap',
  stripAnsi: true,
  headCap: 16 * 1024,
  branchOnExit: true,
};
