// Message box size: how tall the composer is before any text is typed.
// A display preference kept in this browser only (like panel sizes); it
// changes layout and nothing else.
import { useSyncExternalStore } from 'react';

export type MessageBoxSize = 'small' | 'medium' | 'large';
export const MESSAGE_BOX_SIZES: readonly MessageBoxSize[] = ['small', 'medium', 'large'];
export const DEFAULT_MESSAGE_BOX_SIZE: MessageBoxSize = 'small';
export const MESSAGE_BOX_SIZE_KEY = 'arco.messageBoxSize';

const MIN_HEIGHT_PX: Record<MessageBoxSize, number | null> = { small: null, medium: 96, large: 192 };

export function parseMessageBoxSize(raw: unknown): MessageBoxSize {
  return raw === 'medium' || raw === 'large' || raw === 'small' ? raw : DEFAULT_MESSAGE_BOX_SIZE;
}

/** Resting height for the size; `base` is the composer's own small-size minimum. */
export function messageBoxMinHeight(size: MessageBoxSize, base: number): number {
  return MIN_HEIGHT_PX[size] ?? base;
}

/** Tallest the box auto-grows to; never below its resting height. */
export function messageBoxMaxHeight(size: MessageBoxSize, baseMin: number, baseMax: number): number {
  return Math.max(baseMax, Math.round(messageBoxMinHeight(size, baseMin) * 1.6));
}

const listeners = new Set<() => void>();

export function getMessageBoxSize(): MessageBoxSize {
  try { return parseMessageBoxSize(localStorage.getItem(MESSAGE_BOX_SIZE_KEY)); } catch { return DEFAULT_MESSAGE_BOX_SIZE; }
}

export function setMessageBoxSize(size: MessageBoxSize): void {
  try { localStorage.setItem(MESSAGE_BOX_SIZE_KEY, size); } catch { /* storage unavailable: applies until reload */ }
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === MESSAGE_BOX_SIZE_KEY) cb(); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(cb); window.removeEventListener('storage', onStorage); };
}

export function useMessageBoxSize(): MessageBoxSize {
  return useSyncExternalStore(subscribe, getMessageBoxSize, () => DEFAULT_MESSAGE_BOX_SIZE);
}
