// docs/PROVIDERS.md - ls filter pack.
//
// `ls -la` against a deep tree easily breaks 50 KB. Cap small from the
// head — directory listings are alphabetic, the head is the useful part.

import type { FilterPack } from '../filterToolResult.js';

export const bashLs: FilterPack = {
  name: 'ls-head-cap',
  stripAnsi: true,
  headCap: 8 * 1024,
};
