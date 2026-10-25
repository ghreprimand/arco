// EFFICIENCY_PLAN.md Phase C — find filter pack.
//
// `find` and friends produce flat path-per-line output. The hazard is the
// model running an unscoped `find` against node_modules / .git and
// receiving 50k paths. Cap aggressively from the head — sorted output
// from `find` tends to put the most-relevant matches alphabetically; a
// truncated tail is tolerable.

import type { FilterPack } from '../filterToolResult.js';

export const bashFind: FilterPack = {
  name: 'find-head-cap',
  stripAnsi: true,
  headCap: 16 * 1024,
  // Errors on find ("Permission denied" etc.) usually happen interspersed
  // and trail at the end too; tailCap helps when the command failed.
  branchOnExit: true,
};
