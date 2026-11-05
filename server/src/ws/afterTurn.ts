// What runs after a primary turn has fully settled (the queue drained, busy
// released), in a fixed order. Each step reshapes the context the next one
// sees: the Computer context reset, calibration, context actions (auto-fold,
// handoff or the explicit auto-compaction policy), then queued messages,
// then the north-star goal run last. Pinned by afterTurn.test.ts;
// handleUserMessage in turnEngine.ts supplies the steps.

export interface AfterTurnSteps {
  // Rotate and announce the Computer context (Computer chats only).
  computer: () => Promise<void>;
  // Ground-truth context calibration at an idle moment.
  calibrate: () => Promise<void>;
  // Auto-fold, auto-handoff or the explicit policy. 'stop' ends the list (a
  // stale claim, or a compaction that already handled the queue).
  context: () => Promise<'continue' | 'stop'>;
  // Starts a turn for messages queued meanwhile; true when one started, and
  // that turn runs its own after-turn steps.
  drainQueue: () => Promise<boolean>;
  // One tick of an armed goal run.
  goalRun: () => Promise<void>;
}

export const AFTER_TURN_ORDER = ['computer', 'calibrate', 'context', 'queue', 'goal-run'] as const;

// Runs the steps in order and returns the names of those that ran.
export async function runAfterTurn(s: AfterTurnSteps): Promise<string[]> {
  const ran: string[] = [];
  ran.push('computer'); await s.computer();
  ran.push('calibrate'); await s.calibrate();
  ran.push('context'); if (await s.context() === 'stop') return ran;
  ran.push('queue'); if (await s.drainQueue()) return ran;
  ran.push('goal-run'); await s.goalRun();
  return ran;
}
