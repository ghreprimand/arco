// ── Preview-capture WS handler (ARCO_OPS_PLAN.md G1) ──
//
// One operator-driven message: `preview_capture_request`. Resolve the workflow's
// bound preview port, drive a system headless browser at it
// (server/src/preview/captureViaCdp.ts) at the requested viewport preset, write a
// text-only markdown report (screenshot referenced by filename — not embedded) +
// the raw screenshot under the workflow's artifacts dir, and broadcast
// `preview_capture_started` then `preview_capture_ready`. G2 adds viewport
// presets + a layout/accessibility section to the report.
//
// Operator-triggered, deterministic, visible in events.jsonl (both broadcasts
// land there), reversible (artifacts are plain files). No model call.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WebSocket } from 'ws';
import type {
  PreviewCaptureRequestMessage,
  PreviewCaptureKind,
  PreviewCaptureSummary,
  PreviewViewport,
  PreviewLayoutNotes,
} from '@arco/shared';
import { workflows, workflowCwds } from '../server/state.js';
import { send, broadcastWorkflow } from '../server/broadcast.js';
import { artifactsDir } from '../workers/limits.js';
import { capturePreview, type CaptureResult } from '../preview/captureViaCdp.js';

function fail(ws: WebSocket, message: string): void {
  send(ws, { type: 'error', message });
}

// `preview-capture-<ts>` basename, timestamp drives both artifacts + the id.
function stamp(): { id: string; base: string } {
  const ts = Date.now();
  return { id: `cap-${ts}`, base: `preview-capture-${ts}` };
}

// G2 — number of layout/accessibility signals worth a look. Drives the inline
// "· N layout" count AND the order/emphasis of the report section. Each non-zero
// metric (or empty `lang`, or a missing viewport meta on a mobile/tablet render)
// counts as one signal.
function layoutFlagCount(layout: PreviewLayoutNotes): number {
  let n = 0;
  if (layout.horizontalOverflowPx > 0) n++;
  if (layout.imagesMissingAlt > 0) n++;
  if (layout.inputsMissingLabel > 0) n++;
  if (layout.controlsMissingName > 0) n++;
  if (!layout.lang) n++;
  if (!layout.hasTitle) n++;
  if (layout.h1Count === 0) n++;
  if (layout.viewport !== 'desktop' && !layout.viewportMetaPresent) n++;
  return n;
}

// G2 — render the layout/accessibility notes as short human lines. Each line is
// either a flagged signal ("⚠") or a clean check, so the reviewer (and operator)
// sees both what's wrong and what was checked.
function renderLayoutSection(layout: PreviewLayoutNotes): string[] {
  const lines: string[] = ['## Layout & accessibility', ''];
  lines.push(`- **Rendered at:** ${layout.viewport} (${layout.width}×${layout.height})`);
  const sig = (bad: boolean, msg: string) => lines.push(`- ${bad ? '⚠ ' : ''}${msg}`);
  sig(
    layout.horizontalOverflowPx > 0,
    layout.horizontalOverflowPx > 0
      ? `Horizontal overflow: ${layout.horizontalOverflowPx}px wider than the viewport (content is cut off / scrolls sideways).`
      : 'No horizontal overflow.',
  );
  sig(layout.imagesMissingAlt > 0, layout.imagesMissingAlt > 0 ? `${layout.imagesMissingAlt} image(s) missing an \`alt\` attribute.` : 'All images have an `alt` attribute.');
  sig(layout.inputsMissingLabel > 0, layout.inputsMissingLabel > 0 ? `${layout.inputsMissingLabel} form control(s) with no associated label.` : 'Form controls are labelled.');
  sig(layout.controlsMissingName > 0, layout.controlsMissingName > 0 ? `${layout.controlsMissingName} button/link(s) with no accessible name.` : 'Buttons and links have accessible names.');
  sig(!layout.lang, layout.lang ? `Document language: \`${layout.lang}\`.` : 'No `<html lang>` set.');
  sig(layout.h1Count === 0, layout.h1Count === 0 ? 'No `<h1>` heading.' : `${layout.h1Count} \`<h1>\` heading(s).`);
  if (layout.viewport !== 'desktop') {
    sig(!layout.viewportMetaPresent, layout.viewportMetaPresent ? 'Responsive `<meta name="viewport">` present.' : 'No `<meta name="viewport">` — mobile browsers will not scale the layout.');
  }
  lines.push('');
  return lines;
}

function renderReport(
  result: CaptureResult,
  captures: PreviewCaptureKind[],
  imageName: string | undefined,
  when: number,
): string {
  const lines: string[] = [];
  lines.push('# Preview verification');
  lines.push('');
  lines.push(`- **Captured:** ${new Date(when).toISOString()}`);
  if (result.url) lines.push(`- **URL:** ${result.url}`);
  if (result.title) lines.push(`- **Title:** ${result.title}`);
  if (result.layout) lines.push(`- **Viewport:** ${result.layout.viewport} (${result.layout.width}×${result.layout.height})`);
  if (result.browserBinary) lines.push(`- **Browser:** ${result.browserBinary}`);
  lines.push(`- **Requested:** ${captures.join(', ') || '(none)'}`);
  lines.push('');

  if (captures.includes('screenshot')) {
    lines.push('## Screenshot');
    lines.push('');
    // Reference the image artifact by name rather than embedding it. Embedding a
    // base64 data URI would bloat the report (and, when this report is attached
    // to a Review in G2, cost a fortune in tokens for an image the reviewer
    // can't read). The UI shows the actual screenshot via the raw-artifact route.
    if (imageName) lines.push(`Screenshot saved as \`${imageName}\`.`);
    else lines.push('_No screenshot captured._');
    lines.push('');
  }

  if (captures.includes('console')) {
    lines.push('## Console');
    lines.push('');
    if (result.console.length === 0) {
      lines.push('_No console errors or warnings._');
    } else {
      for (const e of result.console) {
        const where = e.source ? ` _(${e.source})_` : '';
        lines.push(`- **${e.level.toUpperCase()}** ${e.text}${where}`);
      }
    }
    lines.push('');
  }

  if (captures.includes('network')) {
    lines.push('## Network');
    lines.push('');
    if (result.network.length === 0) {
      lines.push('_No failed or error-status requests._');
    } else {
      for (const n of result.network) {
        const status = n.status ? `${n.status}` : n.errorText || 'failed';
        const method = n.method ? `${n.method} ` : '';
        lines.push(`- \`${status}\` ${method}${n.url}`);
      }
    }
    lines.push('');
  }

  // G2 — always include the layout/a11y section when notes were collected. It's
  // not scoped by `captures` because it's tied to the render as a whole (viewport
  // presets), and it's the bit the ATTACH TO REVIEW reviewer leans on most.
  if (result.layout) {
    lines.push(...renderLayoutSection(result.layout));
  }

  return lines.join('\n');
}

export async function handlePreviewCaptureRequest(ws: WebSocket, msg: PreviewCaptureRequestMessage): Promise<void> {
  const wf = workflows.get(msg.workflowId);
  if (!wf) {
    fail(ws, 'Cannot capture the preview for an unknown workflow.');
    return;
  }
  const captures: PreviewCaptureKind[] =
    Array.isArray(msg.captures) && msg.captures.length > 0
      ? msg.captures
      : ['screenshot', 'console', 'network'];

  const viewport: PreviewViewport = msg.viewport ?? 'desktop';

  const { id: captureId, base } = stamp();
  broadcastWorkflow(msg.workflowId, {
    type: 'preview_capture_started',
    workflowId: msg.workflowId,
    captureId,
    captures,
    viewport,
  });

  const finish = (ok: boolean, extra: { error?: string; reportName?: string; imageName?: string; summary?: PreviewCaptureSummary }) => {
    broadcastWorkflow(msg.workflowId, {
      type: 'preview_capture_ready',
      workflowId: msg.workflowId,
      captureId,
      ok,
      completedAt: Date.now(),
      ...extra,
    });
  };

  const port = wf.preview?.port;
  if (!port) {
    finish(false, { error: 'No preview is bound for this workflow. Bind a dev-server port in the Preview tab first.' });
    return;
  }
  const cwd = workflowCwds.get(msg.workflowId) ?? wf.config.workingDirectory ?? '';
  if (!cwd) {
    finish(false, { error: 'This workflow has no working directory to store the capture artifact.' });
    return;
  }

  let result: CaptureResult;
  try {
    result = await capturePreview({ port, viewport });
  } catch (err) {
    finish(false, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!result.ok) {
    finish(false, { error: result.error || 'Capture failed.' });
    return;
  }

  const when = Date.now();
  const dir = artifactsDir(cwd, msg.workflowId);
  let imageName: string | undefined;
  try {
    await fs.mkdir(dir, { recursive: true });
    if (result.screenshotBase64 && captures.includes('screenshot')) {
      imageName = `${base}.jpg`;
      await fs.writeFile(path.join(dir, imageName), Buffer.from(result.screenshotBase64, 'base64'));
    }
    const reportName = `${base}.md`;
    await fs.writeFile(path.join(dir, reportName), renderReport(result, captures, imageName, when), 'utf8');

    const summary: PreviewCaptureSummary = {
      ...(result.url ? { url: result.url } : {}),
      ...(result.title ? { title: result.title } : {}),
      consoleErrors: result.console.filter((e) => e.level === 'error').length,
      failedRequests: result.network.length,
      screenshot: !!imageName,
      viewport,
      ...(result.layout ? { layoutFlags: layoutFlagCount(result.layout) } : {}),
    };
    finish(true, { reportName, imageName, summary });
  } catch (err) {
    finish(false, { error: `Capture succeeded but writing the artifact failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}
