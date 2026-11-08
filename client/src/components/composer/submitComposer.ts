import type { Props } from '../TerminalInput';
import type { DraftAttachment, JobState, useAppStore } from '../../stores/appStore';

import { mergeDraftSkillPicks, clearDraftSkillPicks, type DraftSkillPick } from '../../stores/draftStore';

type Store = ReturnType<typeof useAppStore.getState>;
type SubmitOptions = Pick<Props, 'onCompact' | 'onUpdatePrimary' | 'onArmPlanMode' | 'onSend'> & {
  kind?: 'steer' | 'follow-up' | 'interrupt';
  compactAvailable: boolean; isCompacting: boolean; uploading: boolean; readDraft: () => string;
  attachments: DraftAttachment[]; provider: string; isBusy: boolean; job: JobState;
  addMessage: Store['addMessage']; clearAttachments: Store['clearAttachments'];
  setValue: (value: string) => void; planModeArmed: boolean; planModeToggleVisible: boolean;
  setPlanModeArmed: (value: boolean) => void;
  readPickedSkills?: () => DraftSkillPick[];
  pickedSkills: Array<{ scope: 'project' | 'global' | 'builtin'; slug: string; name: string }>;
  setPickedSkills: (value: Array<{ scope: 'project' | 'global' | 'builtin'; slug: string; name: string }>) => void;
};

// Claude Code TUI-only slash commands. Arco runs `claude -p` (non-interactive
// stream-json), so these never reach the interactive dispatcher — they're sent
// as user prompts and come back as errors (e.g. /login → 401). Intercept them
// in the composer so the operator isn't wasting a turn + an auth-token hit.
// `/login` gets routed through the same AUTH notice path as a stream-side 401.
const TUI_ONLY_SLASH_COMMANDS = new Set([
  'login', 'logout', 'context', 'clear', 'model', 'config',
  'help', 'compact', 'cost', 'status', 'doctor', 'memory',
  'agents', 'permissions', 'init', 'ide', 'bug', 'release-notes',
]);

// All send-time routing and side effects live at this seam.
export function submitComposer({ kind, compactAvailable, isCompacting, uploading, readDraft, attachments, provider, isBusy,
  onCompact, addMessage, job, setValue, clearAttachments, onUpdatePrimary, planModeArmed,
  planModeToggleVisible, onArmPlanMode, setPlanModeArmed, onSend, pickedSkills, readPickedSkills, setPickedSkills }: SubmitOptions): void {
    // Phase 3 — block sends while compacting; the worker has no history to
    // receive a turn until the summary lands. The takeover overlay + greyed
    // send already signal this; this is the hard guard.
    if (isCompacting) return;
    // A paste still uploading isn't staged yet — sending now would ship the
    // text without the image and leave the chip staged for the NEXT message.
    if (uploading) return;
    const trimmed = readDraft().trim();
    if (!trimmed && attachments.length === 0) return;

    // Intercept TUI-only slash commands. See TUI_ONLY_SLASH_COMMANDS. `/login`
    // gets the `[AUTH:claude]` prefix so ChatMessage renders a RE-LOGIN button;
    // the rest get a plain hint. Toolbox slash commands (e.g. skills) fall
    // through because their names never collide with these.
    const slashMatch = trimmed.match(/^\/([a-z-]+)(?:\s|$)/);
    // Cursor's real command is `/compress` (not `/compact`). Route it through
    // Arco's provider-native handler so the worker can send the command as an
    // isolated ACP prompt; normal Cursor turns prepend cluster/north-star text
    // and would prevent the slash dispatcher from recognizing it.
    if (slashMatch?.[1] === 'compress' && provider === 'cursor') {
      if (isBusy || !onCompact) {
        addMessage(job.id, {
          id: crypto.randomUUID(),
          role: 'system',
          content: isBusy
            ? 'Cursor compression runs between turns. Wait for the current turn to finish, then use `/compress` or COMPACT.'
            : 'Cursor compression is not available in this view.',
          isStreaming: false,
          timestamp: Date.now(),
        });
      } else {
        onCompact();
      }
      setValue('');
      clearAttachments(job.id);
      return;
    }
    if (slashMatch?.[1] === 'compact' && compactAvailable && onCompact) {
      if (isBusy) {
        addMessage(job.id, { id: crypto.randomUUID(), role: 'system', content: 'Compaction runs between turns. Wait for the current turn to finish, then use /compact or COMPACT.', isStreaming: false, timestamp: Date.now() });
        return;
      }
      onCompact(); setValue(''); clearAttachments(job.id); return;
    }
    if (provider === 'claude' && slashMatch && TUI_ONLY_SLASH_COMMANDS.has(slashMatch[1])) {
      const cmd = slashMatch[1];
      const content = cmd === 'login' || cmd === 'logout'
        ? `[AUTH:claude] "/${cmd}" is a terminal-only Claude CLI command: Arco runs claude non-interactively so it can't reach that dispatcher. Click RE-LOGIN to trigger the OAuth flow, or run claude in a native terminal.`
        : `"/${cmd}" is a terminal-only Claude CLI command and won't reach the model from here. Run it in a native \`claude\` terminal instead.`;
      addMessage(job.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content,
        ...(cmd === 'login' || cmd === 'logout' ? { authRecovery: { transport: 'cli' as const } } : {}),
        isStreaming: false,
        timestamp: Date.now(),
      });
      setValue('');
      clearAttachments(job.id);
      return;
    }

    // docs/GOTCHAS.md - `/goal` composer shortcut. Dispatches the same
    // updatePrimaryConfig the CONFIG NORTH STAR field uses; it never sends a turn.
    //   /goal <objective>    set the standing north-star
    //   /goal                show the current north-star (no change)
    //   /goal clear | none   clear it
    // The server caps to GOAL_MAX_BYTES (2048) and echoes the stored value back
    // via goal_set, which refreshes the store + the NorthStarBar chip. The `[\s\S]`
    // arg allows a multi-line goal (Shift+Enter); `/goalkeeper` etc. don't match
    // (requires end-of-token or whitespace after "goal") so they send normally.
    const goalMatch = trimmed.match(/^\/goal(?:\s+([\s\S]*))?$/i);
    if (goalMatch) {
      const pushSys = (content: string) =>
        addMessage(job.id, { id: crypto.randomUUID(), role: 'system', content, isStreaming: false, timestamp: Date.now() });
      const arg = (goalMatch[1] ?? '').trim();
      const current = job.config.goal?.trim();
      // docs/GOTCHAS.md - `/goal run [n]` arms the north-star auto-continue,
      // `/goal run stop` disarms. Parsed before the set/clear branches so a
      // literal objective of "run …" can't be typed by accident; use CONFIG →
      // NORTH STAR for an objective that genuinely starts with "run".
      const runMatch = arg.match(/^run(?:\s+(.*))?$/i);
      if (runMatch) {
        const runArg = (runMatch[1] ?? '').trim().toLowerCase();
        const run = job.config.goalRun;
        if (!onUpdatePrimary) {
          pushSys('Goal runs aren’t available in this view.');
        } else if (runArg === 'stop' || runArg === 'off') {
          onUpdatePrimary({ goalRun: { enabled: false } });
          pushSys('Stopping the goal run: no further automatic turns.');
        } else if (!runArg) {
          if (run?.enabled) {
            pushSys(`Goal run active: ${run.total - run.remaining}/${run.total} iterations used, ${run.remaining} left. \`/goal run stop\` to stop.`);
          } else {
            pushSys('No goal run active. `/goal run <n>` arms one for n iterations (default 10).');
          }
        } else {
          const n = Number.parseInt(runArg, 10);
          if (!Number.isFinite(n) || n < 1) {
            pushSys('Usage: `/goal run <iterations>` · `/goal run stop` · `/goal run` to check status.');
          } else if (!current) {
            pushSys('Set a north star first: a goal run continues toward it. `/goal <objective>`.');
          } else {
            onUpdatePrimary({ goalRun: { enabled: true, total: n } });
            pushSys(`Goal run armed for ${n} iteration${n === 1 ? '' : 's'}. A continuation turn fires after each settled turn until the budget runs out or you stop it.`);
          }
        }
        setValue('');
        clearAttachments(job.id);
        return;
      }
      if (!arg) {
        // Read-only query — needs no dispatch, so it works even in a degraded
        // view where onUpdatePrimary isn't wired.
        pushSys(current
          ? `North-star (standing objective for this tab): ${current}`
          : 'No north-star set. Type `/goal <objective>` to set one, or use CONFIG → NORTH STAR.');
      } else if (!onUpdatePrimary) {
        pushSys('Setting a north-star isn’t available in this view.');
      } else if (arg.toLowerCase() === 'clear' || arg.toLowerCase() === 'none') {
        onUpdatePrimary({ goal: '' });
        pushSys('North-star cleared.');
      } else {
        onUpdatePrimary({ goal: arg });
        pushSys(`North-star set: ${arg}`);
      }
      setValue('');
      clearAttachments(job.id);
      return;
    }

    // Send-time-fire for operator-armed plan mode. Emit the WS request
    // immediately before the user message so the server processes them in
    // order — pendingPlanModeEntry lands first, then the upcoming turn
    // picks it up. Auto-clear after every send (single-turn arming).
    if (planModeArmed && planModeToggleVisible && onArmPlanMode) {
      onArmPlanMode();
    }
    setPlanModeArmed(false);

    // Phase 4 — `kind` only flows when busy. The hook ignores it on idle
    // sends (where there's no queue to land in). Pre-Phase-4 callers passed
    // no kind; the server still defaults to follow-up for back-compat.
    const currentPicks = mergeDraftSkillPicks(readPickedSkills ? readPickedSkills() : pickedSkills)
      .filter(p => !(job.config.pinnedSkills ?? []).some(pin => pin.scope === p.scope && pin.slug === p.slug));
    const sent = onSend(
      trimmed,
      attachments.length > 0 ? attachments.map((a) => a.path) : undefined,
      kind === 'interrupt' ? kind : isBusy ? kind : undefined,
      undefined,
      currentPicks.length > 0 ? currentPicks.map((s) => ({ scope: s.scope, slug: s.slug })) : undefined,
    );
    if (sent === false) return;
    setValue('');
    clearAttachments(job.id);
    setPickedSkills([]);
    clearDraftSkillPicks(job.id);
}
