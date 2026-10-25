// Barrel for the split protocol type domains. Re-exports every domain file so
// `@arco/shared` (via shared/src/index.ts → ../protocol.js → here) keeps
// exposing the exact same flat surface it did when protocol.ts was one file.
// See docs/FILE_SIZE_REFACTOR_PLAN.md §7.

export * from './providers.js';
export * from './usage.js';
export * from './models.js';
export * from './themes.js';
export * from './settings.js';
export * from './chat.js';
export * from './workers.js';
export * from './workflows.js';
export * from './reviews.js';
export * from './research.js';
export * from './compare.js';
export * from './fallback.js';
export * from './diagnostics.js';
export * from './opsDiagnostics.js';
export * from './llamacppDiagnose.js';
export * from './services.js';
export * from './tasks.js';
export * from './docEdit.js';
export * from './mdTuneup.js';
export * from './handoffs.js';
export * from './checkpoints.js';
export * from './liveChanges.js';
export * from './gitOps.js';
export * from './bakeoffs.js';
export * from './terminal.js';
export * from './plans.js';
export * from './knowledge.js';
export * from './clusters.js';
export * from './templates.js';
export * from './recall.js';
export * from './cookbook.js';
export * from './endpointDiscovery.js';
export * from './media.js';
export * from './remoteManagement.js';
export * from './usageStats.js';
export * from './mcp.js';
export * from './genesis.js';
export * from './previewCapture.js';
export * from './notifications.js';
export * from './orchestrationAssist.js';
export * from './clientMessages.js';
export * from './serverMessages.js';
export * from './ollamaThinking.js';

export * from './localModels.js';
export * from './operatorQuestions.js';
export * from './voiceOperator.js';
export * from './computerConditions.js';

export * from './connections.js';
