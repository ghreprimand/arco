// ANTIGRAVITY_RPC_INTEGRATION_PLAN.md Phase B2 — attachment smoke.
//
// Verifies operator attachments reach Antigravity through stable
// per-workflow staged paths, that images and non-images are split, and
// that the operator gets a clear `system_notice` flagging path-only
// (non-native) delivery.
//
// Drives one turn through the real provider — `AntigravityProvider.create`
// + `spawn(prompt)` — so the staging + framing + notice path under test is
// exactly the code real turns use.
//
// Run: npm run smoke:antigravity-phase-b2
// Exits 0 on success, 1 on failure, 2 if Antigravity is unreachable.

import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { WorkerConfig } from '@archon/shared';
import { antigravityManager } from '../../server/src/providers/antigravityManager.js';
import { AntigravityProvider } from '../../server/src/providers/antigravity.js';

const TURN_TIMEOUT_MS = 5 * 60_000;
const STAMP = Date.now().toString(36);
const WORKFLOW_ID = `b2-${STAMP}`;
const TEXT_MARKER = `marker-${STAMP}-${Math.random().toString(36).slice(2, 8)}`;

// 5x5 solid-red PNG (minimum viable image — recognizable as "red" / "tiny")
// Produced once and embedded so the smoke has no extra deps.
const RED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==';

interface ToolEvent { name: string; status?: string; input: string }

async function setupCwdAndFiles(): Promise<{ cwd: string; textPath: string; imagePath: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'archon-antigrav-b2-'));
  const uploadsDir = join(cwd, '.uploads-src');
  await mkdir(uploadsDir, { recursive: true });
  const textPath = join(uploadsDir, 'note.txt');
  const imagePath = join(uploadsDir, 'red.png');
  const textBody = `B2 smoke fixture\nUnique marker line: ${TEXT_MARKER}\nLine 3: ignore me.\n`;
  await writeFile(textPath, textBody, 'utf8');
  await writeFile(imagePath, Buffer.from(RED_PNG_BASE64, 'base64'));
  return { cwd, textPath, imagePath };
}

async function runTurn(
  prompt: string,
  config: WorkerConfig,
): Promise<{ text: string; tools: ToolEvent[]; notices: string[]; cascadeId: string; modelDisplayName: string }> {
  const proc = AntigravityProvider.create('smoke-b2', config);
  const tools: ToolEvent[] = [];
  const notices: string[] = [];
  let text = '';
  let cascadeId = '';
  let modelDisplayName = '';

  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      reject(new Error(`turn timed out after ${TURN_TIMEOUT_MS}ms`));
    }, TURN_TIMEOUT_MS);

    proc.on('init', (data: { model?: string; sessionId?: string }) => {
      if (data.sessionId) cascadeId = data.sessionId;
      if (data.model) modelDisplayName = data.model;
    });
    proc.on('tool_use', (data: { name: string; status?: string; input: string }) => {
      tools.push({ name: data.name, status: data.status, input: data.input });
    });
    proc.on('system_notice', (n: string) => { notices.push(n); console.log(`  notice: ${n}`); });
    proc.on('result', (r: { text: string }) => { text = r.text; clearTimeout(timer); resolve(); });
    proc.on('error', (msg: string) => { clearTimeout(timer); reject(new Error(msg)); });
  });

  proc.spawn(prompt);
  await done;
  return { text, tools, notices, cascadeId, modelDisplayName };
}

async function main(): Promise<void> {
  console.log('Antigravity Phase B2 smoke (attachments)');
  console.log('========================================');
  console.log(`workflowId: ${WORKFLOW_ID}`);
  console.log(`text marker: ${TEXT_MARKER}`);
  console.log('');

  let failures = 0;
  const fail = (msg: string) => { failures++; console.log(`  FAIL  ${msg}`); };
  const pass = (msg: string) => { console.log(`  PASS  ${msg}`); };

  const diag = await antigravityManager.diagnostics();
  if (!diag.available) {
    console.log(`Antigravity desktop not reachable: ${diag.reason ?? 'unknown'}`);
    console.log('Launch the desktop app (and sign in) and re-run.');
    process.exit(2);
  }

  const { cwd, textPath, imagePath } = await setupCwdAndFiles();
  console.log(`workflow cwd: ${cwd}`);
  console.log(`source text:  ${textPath}`);
  console.log(`source image: ${imagePath}`);

  const config: WorkerConfig = {
    provider: 'antigravity',
    model: 'antigravity-desktop',
    cwd,
    workflowId: WORKFLOW_ID,
    attachments: [textPath, imagePath],
    skipPermissions: true,
  } as WorkerConfig;

  const prompt = `You have two attachments listed below. Two-step task:

1. Read the attached text file (the path under "Attached files"). Find and echo back the unique marker line verbatim in your reply.
2. For the attached image, just echo its absolute path back to me verbatim. Do NOT shell out, do NOT run \`file\`/\`stat\`/etc., do NOT try to view/render the image. Treat the image as opaque — Arco only needs you to confirm you received the path.

Reply with: the marker line and the image path on a single line each.`;

  let res: Awaited<ReturnType<typeof runTurn>>;
  try {
    res = await runTurn(prompt, config);
  } catch (err) {
    fail(`turn failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log('');
  console.log(`display model: ${res.modelDisplayName}`);
  console.log(`cascadeId:     ${res.cascadeId}`);
  console.log(`text (first 600): ${res.text.slice(0, 600)}`);
  console.log(`tool rows (${res.tools.length}):`);
  for (const t of res.tools) {
    console.log(`  - ${t.name}:${t.status ?? '?'}  input=${t.input.slice(0, 140)}`);
  }
  console.log('');

  // 1. Stable per-workflow staging dir exists with both files.
  const stableDir = join(cwd, '.archon', 'workflows', WORKFLOW_ID, 'attachments');
  let staged: string[] = [];
  try { staged = await readdir(stableDir); } catch { staged = []; }
  const stagedTxt = staged.find((n) => n.endsWith('.txt'));
  const stagedPng = staged.find((n) => n.endsWith('.png'));
  console.log(`stable staging dir: ${stableDir}`);
  console.log(`  staged files: ${staged.join(', ') || '(none)'}`);
  if (stagedTxt) pass(`stable copy of text attachment present (${stagedTxt})`);
  else fail('stable copy of text attachment under .archon/workflows/<wfid>/attachments/');
  if (stagedPng) pass(`stable copy of image attachment present (${stagedPng})`);
  else fail('stable copy of image attachment under .archon/workflows/<wfid>/attachments/');

  // 2. Staged text file content matches source.
  if (stagedTxt) {
    const stagedBody = await readFile(join(stableDir, stagedTxt), 'utf8');
    if (stagedBody.includes(TEXT_MARKER)) pass('staged text file content matches source (marker present)');
    else fail('staged text file content matches source');
  }

  // 3. Marker echoed in assistant text (text file reached the model via path
  // ref + tool read).
  if (res.text.includes(TEXT_MARKER)) pass('assistant text echoes the text-file marker');
  else fail(`assistant text echoes the text-file marker (${TEXT_MARKER})`);

  // 4. system_notice clearly labels path-only delivery and mentions image.
  const pathOnlyNotice = res.notices.find((n) => n.includes('[ANTIGRAVITY]') && n.toLowerCase().includes('path'));
  if (pathOnlyNotice && /image/i.test(pathOnlyNotice)) {
    pass('system_notice flags path-only delivery and mentions image(s)');
  } else if (pathOnlyNotice) {
    fail('system_notice flags path-only delivery but does not mention image(s)');
  } else {
    fail('system_notice flags path-only attachment delivery');
  }

  // 5. Tool activity includes file/read/path-shaped rows touching the staged
  // attachment paths.
  const stagedTxtPath = stagedTxt ? join(stableDir, stagedTxt) : '';
  const stagedPngPath = stagedPng ? join(stableDir, stagedPng) : '';
  const stagedRefs = res.tools.filter((t) =>
    (stagedTxtPath && t.input.includes(stagedTxtPath)) ||
    (stagedPngPath && t.input.includes(stagedPngPath)) ||
    t.input.includes(stableDir),
  );
  if (stagedRefs.length > 0) {
    pass(`tool rows reference staged attachment paths (${stagedRefs.length} row(s))`);
  } else {
    const fileShaped = res.tools.filter((t) => /read|write|edit|file|open|view|patch/i.test(t.name));
    if (fileShaped.length > 0) pass(`tool rows include ${fileShaped.length} file-shaped row(s); staged path not captured in input snippet`);
    else fail('tool rows include file/read/path-shaped rows for the staged attachments');
  }

  console.log('');
  if (failures === 0) {
    console.log('All Phase B2 checks passed.');
    console.log(`Leftover workflow cwd (inspect or rm): ${cwd}`);
    process.exit(0);
  } else {
    console.log(`${failures} Phase B2 check(s) failed.`);
    console.log(`Leftover workflow cwd (inspect or rm): ${cwd}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
