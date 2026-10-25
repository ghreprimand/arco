// Antigravity ProviderProcess — drives the running Antigravity desktop app
// via its local language-server RPC (see antigravityRpc.ts). Single class,
// single transport: every primary and reviewer turn goes through RPC.
//
// Reviewer turns set no resumeSessionId, which causes the RPC layer to start
// a fresh cascade. Primary turns pass `resumeSessionId` on turn 2+ to resume
// the same cascade. The cascade id is opaque to Archon and stored on the
// workflow's primarySessionId by the seed worker on the init event.
//
// No subprocess, no token accounting beyond what RPC reports back, no
// mid-turn cancel (Antigravity's in-flight agent work keeps running — kill()
// only detaches Archon from the poll loop).

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { copyFile, mkdir, stat } from 'fs/promises';
import { basename, extname, join } from 'path';
import type { WorkerConfig, WorkerStatus } from '@archon/shared';
import type { Provider, ProviderProcess } from './types.js';
import { runAntigravityRpcTurn } from './antigravityRpc.js';
import { awaitModelImage } from './attachments.js';
import {
  formatAntigravityArtifactAppendix,
  ingestAntigravityArtifacts,
  shouldScanWorkflowCwdForArtifacts,
  snapshotAntigravityArtifactFiles,
  type AntigravityArtifactSnapshot,
} from './antigravityArtifacts.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

interface SplitAttachments {
  images: string[];
  nonImages: string[];
}

function splitAttachments(paths: string[] | undefined): SplitAttachments {
  const images: string[] = [];
  const nonImages: string[] = [];
  for (const p of paths ?? []) {
    if (IMAGE_EXT.has(extname(p).toLowerCase())) images.push(p);
    else nonImages.push(p);
  }
  return { images, nonImages };
}

// Copy each attachment into a stable per-workflow location under the cwd so
// the path Antigravity is told about survives a server restart and the
// transient `server/uploads/<id>` directory turnover. Collision-safe by
// appending `-1`, `-2`, … before the extension if the destination basename
// already exists and points at different content.
// Null on read failure so an unreadable file never counts as a match.
function sha256File(p: string): Promise<string | null> {
  return new Promise((resolve) => {
    const h = createHash('sha256');
    createReadStream(p)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', () => resolve(null));
  });
}

async function stageAttachment(stableDir: string, src: string): Promise<string> {
  const base = basename(src);
  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let candidate = join(stableDir, base);
  let n = 0;
  // Dedupe so a re-attached upload doesn't keep producing -1, -2, -3 copies.
  // Size alone served a same-size edited file stale; size is only the cheap
  // pre-filter, a content hash decides.
  let srcSize = -1;
  try { srcSize = (await stat(src)).size; } catch { /* fall through */ }
  let srcHash: string | null = null;
  while (true) {
    let existing: { size: number } | null = null;
    try { existing = await stat(candidate); } catch { existing = null; }
    if (!existing) break;
    if (srcSize >= 0 && existing.size === srcSize) {
      srcHash ??= await sha256File(src);
      if (srcHash !== null && srcHash === await sha256File(candidate)) return candidate; // already staged
    }
    n += 1;
    candidate = join(stableDir, `${stem}-${n}${ext}`);
  }
  await copyFile(src, candidate);
  return candidate;
}

async function stageAttachments(
  cwd: string,
  workflowId: string,
  split: SplitAttachments,
): Promise<{ images: string[]; nonImages: string[]; stableDir: string }> {
  const stableDir = join(cwd, '.archon', 'workflows', workflowId, 'attachments');
  await mkdir(stableDir, { recursive: true });
  const images = await Promise.all(split.images.map((p) => stageAttachment(stableDir, p)));
  const nonImages = await Promise.all(split.nonImages.map((p) => stageAttachment(stableDir, p)));
  return { images, nonImages, stableDir };
}

function buildAttachmentBlock(images: string[], nonImages: string[]): string {
  const sections: string[] = [];
  if (nonImages.length > 0) {
    sections.push(
      `Attached files for this turn:\n${nonImages.map((p) => `[attached file: ${p}]`).join('\n')}`,
    );
  }
  if (images.length > 0) {
    sections.push(
      `Attached images for this turn (local paths, not native uploads — read with your file/image-view tool):\n${images.map((p) => `[attached image: ${p}]`).join('\n')}`,
    );
  }
  if (sections.length === 0) return '';
  return `${sections.join('\n\n')}\n\nOpen the attached path(s) above with your file tools when the user asks about an attachment.`;
}

function buildPathOnlyNotice(images: string[], nonImages: string[]): string {
  const parts: string[] = [];
  if (images.length > 0) parts.push(`${images.length} image(s) sent as path references (no native image upload)`);
  if (nonImages.length > 0) parts.push(`${nonImages.length} file(s) sent as path references`);
  return `[ANTIGRAVITY] attachments delivered as local file paths, not native Antigravity message parts: ${parts.join('; ')}.`;
}

class AntigravityRpcProcess extends EventEmitter implements ProviderProcess {
  readonly id: string;
  readonly config: WorkerConfig;
  private _status: WorkerStatus = 'spawning';
  private _output = '';
  private aborted = false;

  constructor(id: string, config: WorkerConfig) {
    super();
    this.id = id;
    this.config = config;
  }

  get status(): WorkerStatus { return this._status; }
  get output(): string { return this._output; }
  get pid(): undefined { return undefined; }

  spawn(prompt: string): void {
    this._status = 'running';
    const started = Date.now();
    this.runTurn(prompt).then(
      ({ text, usage }) => {
        if (this.aborted) return;
        this._status = 'completed';
        this._output = text;
        this.emit('text', text);
        this.emit('result', {
          text,
          costUsd: 0,
          durationMs: Date.now() - started,
          ...(usage ? { usage } : {}),
        });
      },
      (err) => {
        if (this.aborted) return;
        this._status = 'failed';
        const msg = err instanceof Error ? err.message : String(err);
        this.emit('error', msg);
      },
    );
  }

  kill(): void {
    if (this._status === 'completed' || this._status === 'failed') return;
    this.aborted = true;
    this._status = 'failed';
    this.emit('error', 'cancelled');
  }

  private async runTurn(prompt: string): Promise<{ text: string; usage?: Record<string, number> }> {
    const cwd = this.config.cwd;
    const rawSplit = splitAttachments(this.config.attachments);
    // Antigravity only ever sees image PATHS, so hand it (and stage) the
    // upload-time downscaled copy when there is one.
    const split = rawSplit.images.length > 0
      ? { ...rawSplit, images: await Promise.all(rawSplit.images.map((p) => awaitModelImage(p))) }
      : rawSplit;
    const hasAny = split.images.length > 0 || split.nonImages.length > 0;
    const turnStartedAt = Date.now();
    let workflowSnapshotBefore: AntigravityArtifactSnapshot | undefined;

    if (cwd && this.config.workflowId && shouldScanWorkflowCwdForArtifacts(prompt)) {
      workflowSnapshotBefore = await snapshotAntigravityArtifactFiles(cwd).catch(() => undefined);
    }

    // Stage attachments to a stable per-workflow location when we have both a
    // cwd and a workflowId. Reviewer-style turns may lack a workflowId — fall
    // back to the original paths in that case so attachments still flow.
    let staged: { images: string[]; nonImages: string[] } = split;
    if (hasAny && cwd && this.config.workflowId) {
      try {
        const out = await stageAttachments(cwd, this.config.workflowId, split);
        staged = { images: out.images, nonImages: out.nonImages };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!this.aborted) {
          this.emit('system_notice', `[ANTIGRAVITY] attachment staging failed (${msg}); using original upload paths for this turn.`);
        }
      }
    }

    const attachmentBlock = buildAttachmentBlock(staged.images, staged.nonImages);
    const promptWithAttachments = attachmentBlock
      ? `${prompt}\n\n${attachmentBlock}`
      : prompt;
    const framedPrompt = cwd
      ? `[Project directory: ${cwd}]\n\n${promptWithAttachments}`
      : promptWithAttachments;

    // One concise notice per turn so the operator knows path-only semantics
    // are in play. Native `SendUserCascadeMessage.items[]` image/file shapes
    // remain unproven (Phase B2 open question); when they land, this notice
    // and the framed-prompt block above are the call sites to swap.
    if (hasAny && !this.aborted) {
      this.emit('system_notice', buildPathOnlyNotice(staged.images, staged.nonImages));
    }

    const result = await runAntigravityRpcTurn(
      framedPrompt,
      this.config,
      (data) => {
        if (!this.aborted) this.emit('init', data);
      },
      () => this.aborted,
      (data) => {
        if (!this.aborted) {
          this.emit('tool_use', {
            ...data,
            provider: 'antigravity',
          });
        }
      },
      (notice) => {
        if (!this.aborted) this.emit('system_notice', notice);
      },
    );
    let text = result.text;
    if (cwd && this.config.workflowId) {
      // Give Antigravity's own file writes a short settle window after the
      // planner response. The source files are never mutated or deleted; Archon
      // only copies conservative extensions into its workflow artifact area.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      try {
        const ingested = await ingestAntigravityArtifacts({
          cwd,
          workflowId: this.config.workflowId,
          cascadeId: result.cascadeId,
          prompt,
          turnStartedAt,
          workflowSnapshotBefore,
          explicitSourcePaths: result.generatedFilePaths,
        });
        if (ingested.records.length > 0) {
          const appendix = formatAntigravityArtifactAppendix(ingested.records);
          text = `${text}${appendix}`;
          if (!this.aborted) {
            const copied = ingested.records.map((r) => r.copiedPath).join(', ');
            this.emit('system_notice', `[ANTIGRAVITY] ingested ${ingested.records.length} artifact(s): ${copied}. Metadata: ${ingested.metadataPath}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!this.aborted) this.emit('system_notice', `[ANTIGRAVITY] artifact ingestion failed: ${msg}`);
      }
    }
    return {
      text,
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }
}

export const AntigravityProvider: Provider = {
  create(id, config) {
    return new AntigravityRpcProcess(id, config);
  },
};
