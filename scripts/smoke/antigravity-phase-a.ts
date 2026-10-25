// ANTIGRAVITY_RPC_INTEGRATION_PLAN.md Phase A — provider-contract smoke.
//
// Does NOT need the Arco dev server. Imports the RPC layer directly and
// drives three turns through the running Antigravity desktop app:
//   1. Catalog lookup — confirms gemini-3-flash-agent is in the RPC model
//      list and prints the resolved display name.
//   2. Text turn — confirms a plain marker echoes back.
//   3. Web-search turn — confirms a search_web (or web-search-shaped)
//      tool_use lands.
//   4. Shell turn — confirms an in-progress + completed shell row lands.
//
// Prereqs (clearly reported on failure):
//   - The Antigravity desktop app must be running and signed in.
//   - ANTIGRAVITY_USE_DEFAULT_PROFILE=1 to share the operator's subscription
//     profile (otherwise Arco's isolated profile must be signed in).
//   - Optional: ANTIGRAVITY_RPC_MODEL overrides the model id (default
//     gemini-3-flash-agent).
//
// Run:
//   npm run smoke:antigravity-phase-a
//
// Exits 0 on success, 1 on failure, 2 if the desktop app isn't reachable.

import type { WorkerConfig } from '@arco/shared';
import { antigravityManager } from '../../server/src/providers/antigravityManager.js';
import { ANTIGRAVITY_CAPABILITIES } from '../../server/src/providers/antigravityCapabilities.js';
import {
  probeAntigravityRpcModel,
  runAntigravityRpcTurn,
} from '../../server/src/providers/antigravityRpc.js';

const MARKER = `arco-phase-a-${Date.now().toString(36)}`;
const TURN_TIMEOUT_MS = 5 * 60_000;

interface ToolEvent {
  name: string;
  status?: string;
  input: string;
}

interface RunResult {
  text: string;
  modelDisplayName: string;
  tools: ToolEvent[];
}

function makeConfig(): WorkerConfig {
  return {
    provider: 'antigravity',
    model: 'antigravity-desktop',
    cwd: process.cwd(),
    skipPermissions: true,
  } as WorkerConfig;
}

async function runTurn(prompt: string, resumeCascadeId?: string): Promise<RunResult & { cascadeId: string }> {
  const tools: ToolEvent[] = [];
  let displayName = '';
  let cascadeId = '';
  let text = '';
  let timedOut = false;
  const config: WorkerConfig = { ...makeConfig(), ...(resumeCascadeId ? { resumeSessionId: resumeCascadeId } : {}) };
  const timer = setTimeout(() => { timedOut = true; }, TURN_TIMEOUT_MS);
  try {
    const result = await runAntigravityRpcTurn(
      prompt,
      config,
      (data) => {
        if (data.sessionId) cascadeId = data.sessionId;
        if (data.model) displayName = data.model;
      },
      () => timedOut,
      (data) => {
        tools.push({ name: data.name, status: data.status, input: data.input });
      },
      (notice) => {
        console.log(`  notice: ${notice}`);
      },
    );
    text = result.text;
    cascadeId = result.cascadeId;
    displayName = result.modelDisplayName;
  } finally {
    clearTimeout(timer);
  }
  return { text, modelDisplayName: displayName, tools, cascadeId };
}

async function main(): Promise<void> {
  console.log('Antigravity Phase A smoke');
  console.log('=========================');
  console.log(`marker: ${MARKER}`);
  console.log('');

  let failures = 0;
  const fail = (msg: string) => { failures++; console.log(`  FAIL  ${msg}`); };
  const pass = (msg: string) => { console.log(`  PASS  ${msg}`); };

  // Step 0 — diagnostics + reachability gate.
  const diag = await antigravityManager.diagnostics();
  console.log('Diagnostics:');
  console.log(`  installed:        ${diag.installed}`);
  console.log(`  desktop reachable:${diag.cdp.reachable} (port :${diag.cdpPort})`);
  console.log(`  profile mode:     ${diag.profileMode}${diag.userDataDir ? ` (${diag.userDataDir})` : ''}`);
  console.log(`  workspace:        ${diag.workspace}`);
  console.log(`  configured model: ${diag.configuredModelId}`);
  console.log(`  capabilities:     ${JSON.stringify(diag.capabilities)}`);
  console.log('');
  if (JSON.stringify(diag.capabilities) !== JSON.stringify(ANTIGRAVITY_CAPABILITIES)) {
    fail('diagnostics.capabilities matches ANTIGRAVITY_CAPABILITIES');
  } else {
    pass('diagnostics.capabilities matches ANTIGRAVITY_CAPABILITIES');
  }
  if (!diag.available) {
    console.log('');
    console.log(`Antigravity desktop not reachable: ${diag.reason ?? 'unknown'}`);
    console.log('Skipping live-turn steps. Launch the desktop app (and sign in) and re-run.');
    process.exit(2);
  }

  // Step 1 — catalog lookup.
  try {
    const probe = await probeAntigravityRpcModel();
    if (!probe.catalogModelIds.includes('gemini-3-flash-agent')) {
      fail(`catalog contains gemini-3-flash-agent (saw ${probe.catalogModelIds.length} models)`);
    } else {
      pass(`catalog contains gemini-3-flash-agent`);
    }
    console.log(`  resolved display model: ${probe.modelDisplayName} (id ${probe.modelId}, enum ${probe.modelEnum})`);
  } catch (err) {
    fail(`catalog lookup: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 2 — plain text turn.
  let cascadeId = '';
  try {
    console.log('');
    console.log('Step 2: text turn (marker echo)');
    const res = await runTurn(`Reply with exactly this token and nothing else: ${MARKER}`);
    cascadeId = res.cascadeId;
    console.log(`  display model: ${res.modelDisplayName}`);
    console.log(`  text (first 200): ${res.text.slice(0, 200)}`);
    if (!res.text.includes(MARKER)) {
      fail('text turn echoes marker');
    } else {
      pass('text turn echoes marker');
    }
  } catch (err) {
    fail(`text turn: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 3 — web search.
  try {
    console.log('');
    console.log('Step 3: web search turn');
    const res = await runTurn(
      `Search the web for the latest Node.js LTS release and cite the source URL. Keep the answer under 80 words.`,
      cascadeId,
    );
    cascadeId = res.cascadeId;
    const webRows = res.tools.filter((t) => /search|web/i.test(t.name));
    console.log(`  tool rows: ${res.tools.map((t) => `${t.name}:${t.status ?? '?'}`).join(', ') || '(none)'}`);
    if (webRows.length === 0) {
      fail('web search emits a search_web-shaped tool_use row');
    } else {
      pass(`web search emits ${webRows.length} search-shaped tool_use row(s)`);
    }
  } catch (err) {
    fail(`web search turn: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 4 — shell.
  try {
    console.log('');
    console.log('Step 4: shell turn');
    const res = await runTurn(
      `Run the shell command \`uname -a\` and tell me the kernel string verbatim. Use your shell/run_command tool — do not guess.`,
      cascadeId,
    );
    const bashRows = res.tools.filter((t) => /bash|shell|run/i.test(t.name));
    console.log(`  tool rows: ${res.tools.map((t) => `${t.name}:${t.status ?? '?'}`).join(', ') || '(none)'}`);
    const sawInProgress = bashRows.some((t) => t.status === 'in_progress' || t.status === 'started');
    const sawCompleted = bashRows.some((t) => t.status === 'completed');
    if (bashRows.length === 0) {
      fail('shell turn emits a shell/run_command-shaped tool_use row');
    } else {
      pass(`shell turn emits ${bashRows.length} shell-shaped tool_use row(s)`);
      if (!sawInProgress) fail('shell row has an in-progress/started status');
      else pass('shell row has an in-progress/started status');
      if (!sawCompleted) fail('shell row has a completed status');
      else pass('shell row has a completed status');
    }
  } catch (err) {
    fail(`shell turn: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log('');
  if (failures === 0) {
    console.log('All Phase A checks passed.');
    process.exit(0);
  } else {
    console.log(`${failures} Phase A check(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
