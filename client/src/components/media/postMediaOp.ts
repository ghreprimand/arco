import type {
  MediaOpSpec,
  MediaOpResult,
  MediaScratchResult,
  MediaInspectResult,
  MediaStemsResult,
  StemModel,
  StemName,
  StemFormat,
} from '@arco/shared';

// Part N2 — the single client entry point for running an ffmpeg media op,
// shared by AudioOpsPanel + VideoOpsPanel. It resolves the INPUT the server
// needs (ffmpeg reads files, not object URLs) and forwards the chosen OUTPUT
// destination.
//
// Two source shapes:
//   • on-disk (`diskPath` + `fileContext`) — a file opened from the workflow's
//     FILES panel. Sent as-is; the server confines it to the cwd.
//   • imported (`importedFile`) — a picker / drag-dropped browser File with no
//     server path. We first POST the bytes to /api/media/scratch (Arco's
//     managed scratch area), then run the op against the absolute path it
//     returns. A scratch op carries NO workflow cwd.
//
// The OUTPUT destination (dir + filename) flows straight to MediaOpRequest.output;
// the server gates the dir by the same access fence and forces the op's target
// extension on the filename. An empty dir/name means "alongside the input / auto
// name" — we omit `output` entirely so the server takes its defaults.

export interface MediaOpSource {
  // cwd-relative (or absolute-within-cwd) on-disk path, or null for an import.
  diskPath: string | null;
  // Browser File needing a scratch upload, or null for an on-disk source.
  importedFile: File | null;
  // Workflow context for an on-disk op (resolves the path + audits to
  // events.jsonl). Absent for a scratch op.
  fileContext?: { cwd: string; workflowId: string };
}

export interface MediaOpOutput {
  dir?: string;
  basename?: string;
}

export interface PostMediaOpArgs {
  source: MediaOpSource;
  spec: MediaOpSpec;
  output?: MediaOpOutput;
  signal: AbortSignal;
}

// Resolve a source to the server-facing { path, cwd, workflowId } an op/inspect
// needs. An on-disk source passes through; an imported File is staged to scratch
// first (and then carries NO workflow cwd — the server allows scratch paths
// regardless of the access fence). Throws on a failed upload / missing source.
export async function resolveServerPath(
  source: MediaOpSource,
  signal: AbortSignal,
): Promise<{ path: string; cwd?: string; workflowId?: string }> {
  if (source.diskPath) {
    return { path: source.diskPath, cwd: source.fileContext?.cwd, workflowId: source.fileContext?.workflowId };
  }
  if (!source.importedFile) throw new Error('no source file to operate on');
  const up = await fetch(`/api/media/scratch?name=${encodeURIComponent(source.importedFile.name)}`, {
    method: 'POST',
    body: source.importedFile,
    signal,
  });
  const ur = (await up.json()) as MediaScratchResult;
  if (!ur.ok || !ur.path) throw new Error(ur.error || 'upload failed');
  return { path: ur.path, cwd: undefined, workflowId: undefined };
}

export async function postMediaOp({ source, spec, output, signal }: PostMediaOpArgs): Promise<MediaOpResult> {
  let path: string;
  let cwd: string | undefined;
  let workflowId: string | undefined;
  try {
    ({ path, cwd, workflowId } = await resolveServerPath(source, signal));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), code: 'bad-path' };
  }

  const hasOutput = !!output && (!!output.dir?.trim() || !!output.basename?.trim());
  const res = await fetch('/api/media/op', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      cwd,
      workflowId,
      path,
      spec,
      ...(hasOutput
        ? { output: { dir: output!.dir?.trim() || undefined, basename: output!.basename?.trim() || undefined } }
        : {}),
    }),
  });
  return (await res.json()) as MediaOpResult;
}

// Part N3 — read-only ffprobe inspect. Resolves the source the same way (staging
// an import to scratch if needed), then POSTs /api/media/inspect. Writes no file.
export async function postMediaInspect(source: MediaOpSource, signal: AbortSignal): Promise<MediaInspectResult> {
  let path: string;
  let cwd: string | undefined;
  let workflowId: string | undefined;
  try {
    ({ path, cwd, workflowId } = await resolveServerPath(source, signal));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), code: 'bad-path' };
  }
  const res = await fetch('/api/media/inspect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ cwd, workflowId, path }),
  });
  return (await res.json()) as MediaInspectResult;
}

// Part N4 — Demucs stem separation. Resolves the source the same way (staging an
// import to scratch if needed), then POSTs /api/media/stems. Long-running; the
// caller's AbortController cancels (server SIGKILLs demucs + rm's the fresh dir).
export interface PostMediaStemsArgs {
  source: MediaOpSource;
  model?: StemModel;
  twoStems?: StemName;
  format?: StemFormat;
  outputDir?: string;
  signal: AbortSignal;
}

export async function postMediaStems({ source, model, twoStems, format, outputDir, signal }: PostMediaStemsArgs): Promise<MediaStemsResult> {
  let path: string;
  let cwd: string | undefined;
  let workflowId: string | undefined;
  try {
    ({ path, cwd, workflowId } = await resolveServerPath(source, signal));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), code: 'bad-path' };
  }
  const res = await fetch('/api/media/stems', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      cwd,
      workflowId,
      path,
      ...(model ? { model } : {}),
      ...(twoStems ? { twoStems } : {}),
      ...(format ? { format } : {}),
      ...(outputDir?.trim() ? { output: { dir: outputDir.trim() } } : {}),
    }),
  });
  return (await res.json()) as MediaStemsResult;
}
