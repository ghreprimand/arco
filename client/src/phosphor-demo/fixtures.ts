import type { ChatMessage } from '@archon/shared';

export const patch = `diff --git a/client/src/themes/apply.ts b/client/src/themes/apply.ts
index 5aa0012..9bb2301 100644
--- a/client/src/themes/apply.ts
+++ b/client/src/themes/apply.ts
@@ -1,6 +1,9 @@
 export function applyPresentation(palette: Palette) {
-  rebuildWorkbench(palette);
+  // Paint changes preserve the active transcript and selection.
+  for (const [role, color] of Object.entries(palette.tokens)) {
+    document.documentElement.style.setProperty(role, color);
+  }
   announcePalette(palette.id);
 }
-const density = palette.density;
+const density = displayPreferences.density;
 const selection = retainSelection();
`;
export const files: Record<string, string> = {
  'client/src/themes/apply.ts': `import type { Palette } from './palette';

/** Synthetic review fixture — not the production implementation. */
export function applyPresentation(palette: Palette) {
  // Paint changes preserve the active transcript and selection.
  for (const [role, color] of Object.entries(palette.tokens)) {
    document.documentElement.style.setProperty(role, color);
  }
  announcePalette(palette.id);
}

const density = displayPreferences.density;
const selection = retainSelection();
const path = '/home/operator/Projects/Archon/client/src/components/RightPanel/PreviewTab.tsx';
`,
  'docs/PRESENTATION_REVIEW.md': `# Presentation review\n\n## Acceptance\n\n- [x] Preserve transcript, timestamps and tool arguments.\n- [x] Keep theme families separate.\n- [ ] Inspect keyboard and zoom behavior.\n- [ ] Operator visual review before rollout.\n\n## Decisions\n\nPalette controls change paint. Effects, density and font preferences are separate. The control plane remains operator initiated.\n\n| Surface | State | Evidence |\n| --- | --- | --- |\n| Conversation | Streaming | Complete messages remain available |\n| Approval | Pending | Editable arguments and rejection |\n| Files | Modified | Unified and split diff |\n`,
  'artifacts/review-017.md': `# VERIFY · Presentation adapter\n\nVerdict: NEEDS ATTENTION\n\n## F01 · Warning color\n\nSeverity: medium. Do not use ordinary body text for warnings. Verify ANSI yellow, red failures, blue links and inserted/deleted lines in the Red Planet palette.\n\n## F02 · Keyboard resize\n\nSeverity: low. A pointer splitter needs ArrowLeft/ArrowRight and Home/End equivalents.\n\nReviewed 2026-09-07 14:32:18 · 3 files · 2 findings · 1 resolved.\n`,
  'server/src/providers/worker.ts': `// Synthetic terminal output source\nexport async function runTurn(signal: AbortSignal) {\n  if (signal.aborted) throw new Error('Turn cancelled');\n  return { status: 'settled', inputTokens: 48210, outputTokens: 3912 };\n}\n`,
  'package.json': '{\n  "name": "archon-preview-fixture",\n  "private": true,\n  "scripts": { "check": "tsc --noEmit" }\n}\n',
};

const at = Date.parse('2026-09-07T19:20:00Z');
function message(id: string, role: ChatMessage['role'], content: string, offset: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, content, timestamp: at + offset * 1000, isStreaming: false, ...extra };
}
export const history: ChatMessage[] = Array.from({ length: 14 }, (_, i) => [
  message(`user-${i}`, 'user', `Review pass ${i + 1}: preserve the complete operational context for the presentation changes. Check the transcript, file paths, tool arguments and counts before marking this pass complete.`, i * 30),
  message(`assistant-${i}`, 'assistant', `### Pass ${i + 1} / presentation audit\n\nThe workbench retains its active workflow and panel state. The same content is available in each palette, including this history.\n\n- **Transcript:** messages remain selectable; code blocks keep their language and copy action.\n- **Operations:** approvals, failed tools and pending input retain separate states.\n- **Evidence:** 3 modified files, 2 review findings, ${i + 1} inspected sections.\n\n\`/home/operator/Projects/Archon/client/src/components/RightPanel/PreviewTab.tsx\` remains accessible in full.\n\n\`\`\`typescript\nconst result = { pass: ${i + 1}, state: 'reviewed', preserved: true };\nif (!result.preserved) throw new Error('Content preservation failed');\n\`\`\``, i * 30 + 12),
]).flat();

export const recent: ChatMessage[] = [
  message('request', 'user', 'Keep the theme switch live while I review this change. Preserve the panel split, transcript scroll and draft. Show the proposed patch and the remaining review findings.', 440),
  message('read-tool', 'assistant', '', 442, { toolUse: { tool: 'Read', input: { file_path: '/demo/Archon/client/src/themes/apply.ts', offset: 1, limit: 294 }, filePath: '/demo/Archon/client/src/themes/apply.ts', toolUseId: 'read-1' } }),
  message('analysis', 'assistant', 'The palette change can stay a paint-only operation. The active content, selected file and split position stay mounted.\n\n### Review notes\n\n1. Keep **Classic** IDs and saved preferences intact.\n2. Apply the shared phosphor treatment across every imported palette.\n3. Preserve semantic colors for errors, warnings and code.\n\n\`\`\`typescript\nfor (const [role, color] of Object.entries(palette.tokens)) {\n  document.documentElement.style.setProperty(role, color);\n}\n\`\`\`\n\nThe patch is in **FILES → CHANGES**. See [presentation review](docs/PRESENTATION_REVIEW.md) for the checklist.', 447),
  message('bash-tool', 'assistant', '', 450, { toolUse: { tool: 'Bash', input: { command: 'npm run typecheck -w client', timeout: 120000, description: 'Check the presentation types' }, toolUseId: 'bash-1' } }),
  message('error', 'system', '[ERROR] Fixture check exited 2 · client/src/themes/palette.ts:41:9 — property “selection” is missing. Output retained in TERMINAL. Retry is available after the adapter change.', 452),
  message('latest', 'assistant', '**The remaining boundary is selection contrast.** I’ve added an explicit selection foreground and kept diff additions, deletions and terminal ANSI colors separate from the body color.\n\n| Check | State | Detail |\n| --- | --- | --- |\n| Catalog | Passed | 68 imported palettes |\n| Classic compatibility | Passed | 43 existing selections |\n| Visual review | Pending | Operator approval |\n\nNo rollout has been requested. The review artifact includes the two open findings.', 455),
  message('gate::fixture-gate', 'assistant', '', 456, { toolUse: { tool: 'Gate', toolUseId: 'gate-1', input: { gateId: 'fixture-gate', toolName: 'Bash', category: 'bash', reason: 'Review the proposed validation command before it runs.', proposedArgs: { command: 'npm run typecheck -w client', timeout: 120000 }, status: 'pending' } } }),
  message('ask', 'system', '[ASK:claude-native:fixture-question] Which review surface should be inspected next?\n[ASK_OPTIONS:Code and diffs | Keyboard and zoom | Palette contrast]', 457),
];
export const streamText = 'The preview remains open for comparison. Palette changes update colors in place; density and accessibility overrides remain independent. Static glyph emission and raster remain visible with reduced motion, and the ambient canvas pauses whenever the page is hidden.';
