import { useAppStore } from '../../stores/appStore';

// WORKBENCH_EXPANSION §H1 — standalone open helpers for the Media studio. Two
// entry points per the plan: standalone (open empty in a mode, Import a file)
// and contextual (open with an on-disk file already routed to the right mode).
// Thin wrappers over the appStore.mediaStudio companion state so call sites
// (header button, command palette, Files right-click) don't poke the store
// shape directly.

export type MediaMode = 'image' | 'audio' | 'video';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi']);

// Classify a filename's extension into a media mode, or null if it isn't media.
// Used by both the launchers (route to the right editor) and FileExplorer
// (decide whether to show the media context menu at all).
export function classifyMediaExt(filename: string): MediaMode | null {
  const name = (filename.split('/').pop() || '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

// Standalone: open the studio empty in a mode (default image). The Import
// affordance is front-and-centre since there's no path.
export function openMediaStudio(mode: MediaMode = 'image'): void {
  useAppStore.getState().setMediaStudio({ open: true, mode });
}

// A RELATIVE path resolves against a cwd server-side; `context` pins WHICH one
// (the workflow the file belongs to). Omitted, the host falls back to the
// active tab's cwd — fine for Files-panel opens, wrong for artifacts surfaced
// while a different tab is focused.
export interface MediaFileContext { cwd: string; workflowId: string }

// Contextual: classify the on-disk path and open the host in the matching mode
// with that path. Non-media paths are ignored (caller should gate, but we
// fail safe).
export function openMediaFile(path: string, context?: MediaFileContext): void {
  const mode = classifyMediaExt(path);
  if (!mode) return;
  useAppStore.getState().setMediaStudio({ open: true, mode, path, context });
}

// §H4 — open an image path straight into the H2 raster EDITOR (not just the
// viewer). Used by the "Open in editor" affordance on a generated-image
// artifact. Forces image mode; non-image paths fall back to the plain viewer.
export function openImageForEdit(path: string, context?: MediaFileContext): void {
  const mode = classifyMediaExt(path);
  if (mode !== 'image') {
    // Not an image — fail safe to the plain contextual open.
    openMediaFile(path, context);
    return;
  }
  useAppStore.getState().setMediaStudio({ open: true, mode: 'image', path, edit: true, context });
}
