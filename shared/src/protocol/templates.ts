// Workbench Expansion §D4 — project / session templates ("recipes").
//
// A WorkflowTemplate is the single-tab analogue of a cluster preset
// (shared/src/protocol/clusters.ts ClusterPreset): an operator-saved snapshot
// of a creator's config so a new tab can be minted in one click. Persisted at
// ~/.arco/templates.json; CRUD over HTTP (GET/POST/DELETE /api/templates) —
// NOT the workflow-scoped WS, since this is a global library with no replay
// semantics. See server/src/templates/store.ts.
//
// Two deliberate divergences from ClusterPreset, both per the §D4 design
// decisions:
//   • `config.workingDirectory`, `seedPrompt`, and `plan` are OPTIONAL. Cluster
//     presets exclude cwd outright (project-agnostic). D4 supports BOTH the
//     project-pinned recipe ("new Ledger tab", cwd baked in) and the portable
//     one: present → pre-fill on apply; absent → leave the creator's current
//     value untouched.
//   • `seedPrompt` / `plan` are post-create user actions (WorkflowConfig
//     carries neither). On apply the client PRE-FILLS the composer + plan; it
//     NEVER auto-sends. Auto-sending would breach the operator-initiated fence.
//
// The persisted `model` is validated against the LIVE catalog at APPLY time
// (mirrors cluster-preset apply), not at save time — so a recipe survives a
// model rename and fails loud only when the operator instantiates it.

import type { WorkflowConfig } from './workflows.js';

// The slice of WorkflowConfig a template snapshots: everything EXCEPT `name`
// (the new tab names itself), `kind` (templates are single-workflow only), and
// the transient resume/spawn fields that only make sense for one live create.
// `workingDirectory` is narrowed to optional here (it is required on
// WorkflowConfig) so a portable recipe can omit it.
export type WorkflowTemplateConfig = Omit<
  WorkflowConfig,
  'name' | 'kind' | 'workingDirectory' | 'researchSpawnToken' | 'resumeSessionId' | 'resumeWorkflowId'
> & {
  workingDirectory?: string;
};

export interface WorkflowTemplate {
  id: string;        // crypto.randomUUID()
  name: string;      // operator-typed, trimmed, ≤64; unique case-insensitive
  createdAt: string; // ISO timestamp
  config: WorkflowTemplateConfig;
  // Optional composer pre-fill. Applied client-side by seeding the new tab's
  // draft — never auto-sent.
  seedPrompt?: string;
  // Optional plan body (markdown). On apply the client POSTs it to
  // /api/plans (attach:true) against the new workflow so the PLAN tab pre-fills.
  plan?: string;
}
