import { randomUUID } from 'node:crypto';
import type { ComputerActivityEvent } from '@archon/shared';

type Input = Omit<ComputerActivityEvent, 'id' | 'at'>;
const listeners = new Set<(event: ComputerActivityEvent) => void>();
// Mutation sites publish facts after committing state. Subscribers schedule
// async work; they never hold up a mailbox lock or the turn's busy release.
export function publishActivity(event: Input) {
  const stamped = { ...event, id: randomUUID(), at: Date.now() };
  for (const listener of listeners) listener(stamped);
}
export function subscribeActivity(listener: (event: ComputerActivityEvent) => void) {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
const updates = new Set<() => void>();
export function computerProjectionChanged() { for (const listener of updates) listener(); }
export function subscribeComputerProjection(listener: () => void) { updates.add(listener); return () => { updates.delete(listener); }; }
const policies = new Set<(ownerId: string) => void>();
export function computerPolicyChanged(ownerId: string) { for (const listener of policies) listener(ownerId); }
export function subscribeComputerPolicy(listener: (ownerId: string) => void) { policies.add(listener); return () => { policies.delete(listener); }; }
