// `update_primary_config` handler — live per-tab edits to the primary worker's
// model / effort / account + the per-workflow toggles (transports, efficiency
// knobs, output style, remote opt-in). Split out of workflowHandlers.ts to keep
// that file under the size budget; the logic is unchanged.
//
// Source-of-truth rule: each field is mirrored into BOTH the in-memory
// WorkflowState (wf.config / wf.primary, read by the next turn) AND meta.json
// (read on rehydrate). Keep the two blocks below in sync when adding a field.

import { WebSocket } from 'ws';
import type { UpdatePrimaryConfigMessage } from '@archon/shared';
import { send, broadcastWorkflow, broadcastTransient } from '../server/broadcast.js';
import { workflows } from '../server/state.js';
import { capGoal } from '../providers/goalBlock.js';
import { normalizeGoalRunArm } from '../goalRun.js';
import { deriveAutoFold, startSessionWatcher } from './turnEngine.js';
import { updateMeta } from '../workflowMeta.js';
import { disposeProviderResources } from '../providers/index.js';
import { refreshHubReporting } from '../management/initHubLink.js';
import { buildPinnedSkillsBlock, resolvePinnedSkills } from '../skills.js';
import type { Session } from '../workflows/types.js';

export async function handleUpdatePrimaryConfig(
  ws: WebSocket,
  session: Session,
  msg: UpdatePrimaryConfigMessage,
): Promise<void> {
  const wf = workflows.get(msg.workflowId);
  if (!wf) {
    send(ws, { type: 'error', message: `Unknown workflow ${msg.workflowId.slice(0, 8)}` });
    return;
  }
  if (msg.model === undefined && msg.effort === undefined && msg.providerAccountRef === undefined && msg.autoHandoff === undefined && msg.autoFold === undefined && msg.codexTransport === undefined && msg.codexContextPolicy === undefined && msg.claudeTransport === undefined && msg.ultracode === undefined && msg.webSearchMaxUses === undefined && msg.chatWebAccess === undefined && msg.zaiTransport === undefined && msg.claudeNativeCompact === undefined && msg.claudeNativeForceInterleavedThinkingBeta === undefined && msg.claudeNativeThinkingDisplay === undefined && msg.nativeCompactAutoContinue === undefined && msg.efficiencyToolFilter === undefined && msg.efficiencyFactForce === undefined && msg.efficiencyConfigProtection === undefined && msg.efficiencySandbox === undefined && msg.reviewSafeMode === undefined && msg.outputStyle === undefined && msg.goal === undefined && msg.goalRun === undefined && msg.pinnedSkills === undefined && msg.remoteEnabled === undefined && msg.remoteGatesEnabled === undefined && msg.ollamaParams === undefined) return;

  if (msg.model !== undefined) wf.primary.model = msg.model;
  if (msg.effort !== undefined) wf.primary.effort = msg.effort;
  if (msg.providerAccountRef !== undefined) {
    if (wf.busy) {
      send(ws, { type: 'error', message: 'Cannot change account profile while a turn is running.' });
      return;
    }
    wf.config.providerAccountRef = msg.providerAccountRef || undefined;
    disposeProviderResources(msg.workflowId);
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] provider.account updated → ${msg.providerAccountRef || 'default'}`);
  }

  // Phase 3 — update auto-handoff config. Mirrors into wf.config so the
  // client receives the updated config on next rehydrate.
  if (msg.autoHandoff !== undefined) {
    wf.autoHandoff.enabled = msg.autoHandoff.enabled;
    wf.autoHandoff.warnAt = msg.autoHandoff.warnAt;
    wf.autoHandoff.autoAt = msg.autoHandoff.autoAt;
    wf.config.autoHandoff = { ...msg.autoHandoff };
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] auto-handoff updated → enabled=${msg.autoHandoff.enabled} warn=${msg.autoHandoff.warnAt}% auto=${msg.autoHandoff.autoAt}%`);
  }

  // §2.1 — auto-fold config. Mirror into the live state (deriveAutoFold carries
  // the runtime fired/anti-thrash counters) so the next post-turn check honors
  // it without a reload.
  if (msg.autoFold !== undefined) {
    wf.config.autoFold = { ...msg.autoFold };
    wf.autoFold = deriveAutoFold(wf.config);
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] auto-fold updated → enabled=${msg.autoFold.enabled} foldAt=${msg.autoFold.foldAt}%`);
  }

  // GOAL_RUN_PLAN.md — arm / re-arm / disarm the north-star auto-continue.
  // Deliberately NOT mirrored into meta.json (see GoalRunStateMessage): the
  // run is in-memory, so a restart ends it. Evaluated against the goal AFTER
  // the `msg.goal` block above runs, so `/goal <text>` + arm in one message
  // works.
  let goalRunBroadcast: { enabled: boolean; total: number; remaining: number; tokensUsed: number; tokenBudget?: number } | undefined;
  if (msg.goalRun !== undefined) {
    const next = normalizeGoalRunArm(msg.goalRun, !!wf.config.goal?.trim());
    if (typeof next === 'string') {
      send(ws, { type: 'error', message: next });
      return;
    }
    if (next.enabled) {
      wf.config.goalRun = next;
    } else {
      delete wf.config.goalRun;
    }
    goalRunBroadcast = next;
    console.log(
      `[archon] [${msg.workflowId.slice(0, 8)}] goal run ${next.enabled ? `armed → ${next.total} iteration(s)` : 'disarmed'}`,
    );
  }

  // Chat-only web access. Written unconditionally (cheap, and only chat turns
  // read it) so the toggle survives a provider swap on the same tab. Takes
  // effect on the next message — each turn recomputes chatWebArmed().
  if (msg.chatWebAccess !== undefined) {
    wf.config.chatWebAccess = msg.chatWebAccess;
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] chat.web updated → ${msg.chatWebAccess ? 'armed' : 'off'}`);
  }

  // Phase 6e — per-tab Codex transport. handleUserMessage prefers this over
  // the cascade so the toggle takes effect on the next operator turn without
  // touching settings.json. Honored only on Codex tabs; written for any
  // provider so a Handoff that swaps from claude→codex on the same tab still
  // sees the operator's pinned choice.
  if (msg.codexTransport !== undefined) {
    wf.config.codexTransport = msg.codexTransport;
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] codex.transport updated → ${msg.codexTransport}`);
  }
  if (msg.codexContextPolicy !== undefined) {
    wf.config.codexContextPolicy = msg.codexContextPolicy;
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] codex.context updated → ${msg.codexContextPolicy}`);
  }
  // Phase 7a — same shape for Claude. Honored only on Claude tabs but written
  // unconditionally so a Handoff that swaps from codex→claude on the same
  // tab still sees the operator's pinned choice.
  if (msg.claudeTransport !== undefined) {
    wf.config.claudeTransport = msg.claudeTransport;
    // The CLI-session JSONL watcher is CLI-transport-only (a Native tab's
    // transcript truth is events.jsonl; watching a stale CLI file painted
    // calibration-probe junk over real answers — 2026-08-02 incident). A live
    // swap must move the watcher NOW, not at the next restart: stop it on the
    // native direction, (re)start it on the cli direction — nothing on the
    // normal turn path starts it (only create/rehydrate and handoff rotation
    // do), so without this a cli→native→cli round trip leaves it dead.
    if (msg.claudeTransport === 'native') {
      if (wf.sessionWatcher) {
        try { wf.sessionWatcher(); } catch { /* already disposed */ }
        wf.sessionWatcher = null;
      }
    } else if (wf.config.workingDirectory) {
      startSessionWatcher(msg.workflowId, wf, wf.config.workingDirectory, ws);
    }
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] claude.transport updated → ${msg.claudeTransport}`);
  }
  // ULTRACODE_PLAN.md — sticky ultracode toggle. We deliberately do NOT mutate
  // wf.config.claudeTransport here: turnEngine forces 'cli' at turn time while
  // this is on, so the stored base transport stays intact and restores itself
  // when ultracode flips off. Takes effect on the next turn; reversible.
  if (msg.ultracode !== undefined) {
    wf.config.ultracode = msg.ultracode;
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] ultracode → ${msg.ultracode ? 'ON (CLI + Workflow + xhigh forced next turn)' : 'OFF'}`);
  }
  // Per-tab Claude Native web budget (server-tool max_uses). Clamp to a sane
  // range; 0/negative would disable web tools entirely, which is what the
  // posture picker is for — keep at least 1. Takes effect next turn.
  if (msg.webSearchMaxUses !== undefined) {
    const clamped = Math.max(1, Math.min(50, Math.round(msg.webSearchMaxUses)));
    wf.config.webSearchMaxUses = clamped;
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] web search budget → ${clamped}/turn`);
  }
  if (msg.zaiTransport !== undefined) {
    wf.config.zaiTransport = msg.zaiTransport;
    disposeProviderResources(msg.workflowId);
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] zai.transport updated → ${msg.zaiTransport}`);
  }
  // Phase 7c-followup — Claude Native server-side compaction. Honored on
  // Native tabs only, but stored unconditionally so a transport flip
  // back to Native picks up the operator's last pinned value.
  if (msg.claudeNativeCompact !== undefined) {
    wf.config.claudeNativeCompact = msg.claudeNativeCompact;
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] claude.native.compact updated → ${msg.claudeNativeCompact}`);
  }
  if (msg.claudeNativeForceInterleavedThinkingBeta !== undefined) {
    wf.config.claudeNativeForceInterleavedThinkingBeta = msg.claudeNativeForceInterleavedThinkingBeta;
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] claude.native.force-interleaved-beta updated → ${msg.claudeNativeForceInterleavedThinkingBeta}`);
  }
  // Adaptive-thinking display. Stored unconditionally so a CLI→Native
  // transport flip picks up the operator's last pinned value; only the
  // Native worker's buildThinkingParams reads it. Takes effect next turn.
  if (msg.claudeNativeThinkingDisplay !== undefined) {
    wf.config.claudeNativeThinkingDisplay = msg.claudeNativeThinkingDisplay;
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] claude.native.thinking-display updated → ${msg.claudeNativeThinkingDisplay}`);
  }
  // NATIVE_COMPACTION_PLAN Phase 3 — opt-in auto-continue after compaction.
  // Stored unconditionally so a transport flip back to Native picks up the
  // operator's last pinned value; only the Native compaction paths read it.
  if (msg.nativeCompactAutoContinue !== undefined) {
    wf.config.nativeCompactAutoContinue = msg.nativeCompactAutoContinue;
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] native.compact.auto-continue updated → ${msg.nativeCompactAutoContinue}`);
  }
  // EFFICIENCY_PLAN.md Phase C — Native tool-result filter mode. Stored
  // unconditionally so a CLI→Native transport flip picks up the operator's
  // last pinned value; only honored on Native turns at handleUserMessage.
  if (msg.efficiencyToolFilter !== undefined) {
    wf.config.efficiencyToolFilter = msg.efficiencyToolFilter;
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] efficiency.tool-filter updated → ${msg.efficiencyToolFilter}`);
  }
  // EFFICIENCY_PLAN.md Phase D §8a — fact-force first-edit gate. Stored
  // unconditionally so a CLI→Native transport flip picks up the operator's
  // last pinned value; only honored on Native turns at handleUserMessage.
  if (msg.efficiencyFactForce !== undefined) {
    wf.config.efficiencyFactForce = msg.efficiencyFactForce;
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] efficiency.fact-force updated → ${msg.efficiencyFactForce}`);
  }
  // Config-protection write-gate. Stored unconditionally so a CLI→Native
  // transport flip picks up the operator's last pinned value; only honored
  // on Native turns (the gate lives in the Native worker's dispatchTool).
  if (msg.efficiencyConfigProtection !== undefined) {
    wf.config.efficiencyConfigProtection = msg.efficiencyConfigProtection;
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] efficiency.config-protection updated → ${msg.efficiencyConfigProtection}`);
  }
  // EFFICIENCY_PLAN.md Phase E §9 — opt-in sandbox tools. Stored
  // unconditionally so a CLI→Native flip picks up the last pinned
  // value; honored only on Native turns at handleUserMessage.
  if (msg.efficiencySandbox !== undefined) {
    wf.config.efficiencySandbox = msg.efficiencySandbox;
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] efficiency.sandbox updated → ${msg.efficiencySandbox}`);
  }
  // DEBAG_PLAN.md — operator-armed durable review gate. Stored unconditionally
  // so a transport flip picks up the last pinned value; honored only on Native
  // turns (the gate lives in the Native worker's dispatchTool).
  if (msg.reviewSafeMode !== undefined) {
    wf.config.reviewSafeMode = msg.reviewSafeMode;
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] review-safe-mode updated → ${msg.reviewSafeMode}`);
  }
  // OUTPUT_STYLE_PLAN.md — operator-armed terseness picker. Stored
  // unconditionally so a transport/provider flip picks up the last pinned
  // value where supported (Claude Native, Codex app-server, Z.ai). Legacy
  // `'caveman'` (renamed `'terse'` 2026-05-10) is auto-aliased so a stale
  // client build can still talk to a fresh server.
  if (msg.outputStyle !== undefined) {
    const normalized = (msg.outputStyle as string) === 'caveman' ? 'terse' : msg.outputStyle;
    wf.config.outputStyle = normalized;
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] output-style updated → ${normalized}`);
  }
  // GOAL_NORTHSTAR_PLAN.md — operator-set persistent north-star. Trim + byte-cap;
  // empty / whitespace-only ⇒ clear (delete the field so pre-feature meta.json
  // stays byte-clean). We mutate wf.config now (the next turn reads it) but DEFER
  // the goal_set broadcast until AFTER the meta.json write below — persist-then-
  // announce, so "goal_set observed ⇒ value already durable" holds and a client
  // (or the smoke) that reads meta.json on the event never races the disk write.
  // It's the ONLY event this handler emits, since the value carries a
  // definition-of-done worth logging (unlike the cosmetic toggles).
  let goalBroadcast: { goal: string | null; byteLen: number } | undefined;
  if (msg.goal !== undefined) {
    const capped = capGoal(msg.goal);
    if (capped) wf.config.goal = capped;
    else delete wf.config.goal;
    goalBroadcast = { goal: capped || null, byteLen: capped ? Buffer.byteLength(capped, 'utf8') : 0 };
  }
  // Standing skill pins are a whole-set replacement. Resolve before persisting
  // so malformed / missing references never become durable config, and report
  // current prompt bytes for cost visibility. Bodies remain on disk and are
  // re-read at every turn; this snapshot is only the pin acknowledgement.
  let pinnedSkillsBroadcast: {
    skills: Array<{ scope: 'project' | 'global'; slug: string; name: string }>;
    bytes: number;
    missing: string[];
  } | undefined;
  if (msg.pinnedSkills !== undefined) {
    const requested = Array.isArray(msg.pinnedSkills) ? msg.pinnedSkills : [];
    const resolved = await resolvePinnedSkills(requested, wf.config.workingDirectory);
    const refs = resolved.skills.map((s) => ({ scope: s.scope, slug: s.slug }));
    if (refs.length > 0) wf.config.pinnedSkills = refs;
    else delete wf.config.pinnedSkills;
    const block = buildPinnedSkillsBlock(resolved.skills);
    pinnedSkillsBroadcast = {
      skills: resolved.skills.map((s) => ({ scope: s.scope, slug: s.slug, name: s.name })),
      bytes: block.bytes,
      missing: [...resolved.missing, ...resolved.truncated],
    };
  }
  // REMOTE_MANAGEMENT.md §1.4 — per-workflow hub opt-in (`REMOTE CONTINUATION`).
  // Default OFF. Flipping it re-pushes the hub snapshot + re-broadcasts
  // hub_link_status below so the VPS console and the header monitored-count
  // update immediately.
  let remoteEnabledChanged = false;
  if (msg.remoteEnabled !== undefined && msg.remoteEnabled !== wf.config.remoteEnabled) {
    wf.config.remoteEnabled = msg.remoteEnabled;
    remoteEnabledChanged = true;
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] remote-enabled updated → ${msg.remoteEnabled}`);
  }
  // R1 §9.2 — remote-gates arming shares remoteEnabled's re-push semantics so
  // the console's gate buttons track the flip without waiting for the 4s tick.
  if (msg.remoteGatesEnabled !== undefined && msg.remoteGatesEnabled !== wf.config.remoteGatesEnabled) {
    wf.config.remoteGatesEnabled = msg.remoteGatesEnabled;
    remoteEnabledChanged = true;
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] remote-gates updated → ${msg.remoteGatesEnabled}`);
  }

  // LOCAL_AI_MASTER_PLAN.md M3 — Ollama per-tab param preset blob. Stored
  // unconditionally (cheap; only Ollama turns read it) so a Handoff that swaps
  // to ollama on the same tab still sees the operator's pinned preset. The
  // blob is whole-replace, not a patch: the client sends the full edited
  // record so clearing a field is just dropping its key. PREFIX-CACHE note:
  // Ollama keys its prefix cache on request byte-stability, so the merged
  // `options` envelope must stay byte-stable across a workflow's turns. This
  // handler is the ONLY place the preset changes between turns — i.e. the
  // explicit operator-driven cache-invalidation event — so we log it the same
  // way the effort switch is logged. The next Ollama turn re-prefills its
  // prompt (one-time cost the operator opted into).
  if (msg.ollamaParams !== undefined) {
    wf.config.ollamaParams = msg.ollamaParams;
    const keys = Object.keys(msg.ollamaParams).join(', ') || '(cleared)';
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] ollama.params updated → ${keys} (prefix cache invalidates next turn)`);
  }

  // Mirror into the wire-facing config too so rehydrate / snapshot reflects the
  // change; fields on WorkflowConfig and PrimaryConfig are the source of
  // truth together (derivePrimaryConfig reads from config).
  if (msg.model !== undefined) wf.config.primaryModel = msg.model;
  if (msg.effort !== undefined) wf.config.primaryEffort = msg.effort;

  const cwd = wf.config.workingDirectory;
  if (cwd) {
    try {
      await updateMeta(cwd, msg.workflowId, (meta) => {
        if (msg.model !== undefined) meta.primaryModel = msg.model;
        if (msg.effort !== undefined) meta.primaryEffort = msg.effort;
        if (msg.providerAccountRef !== undefined) meta.providerAccountRef = msg.providerAccountRef || undefined;
        if (msg.autoHandoff !== undefined) meta.autoHandoff = { ...msg.autoHandoff };
        if (msg.autoFold !== undefined) meta.autoFold = { ...msg.autoFold };
        if (msg.codexTransport !== undefined) meta.codexTransport = msg.codexTransport;
        if (msg.codexContextPolicy !== undefined) meta.codexContextPolicy = msg.codexContextPolicy;
        if (msg.claudeTransport !== undefined) meta.claudeTransport = msg.claudeTransport;
        if (msg.ultracode !== undefined) meta.ultracode = msg.ultracode;
        if (msg.webSearchMaxUses !== undefined) meta.webSearchMaxUses = wf.config.webSearchMaxUses;
        if (msg.chatWebAccess !== undefined) meta.chatWebAccess = msg.chatWebAccess;
        if (msg.zaiTransport !== undefined) meta.zaiTransport = msg.zaiTransport;
        if (msg.claudeNativeCompact !== undefined) {
          meta.claudeNativeCompact = msg.claudeNativeCompact;
          if (msg.claudeNativeCompact === true) {
            meta.claudeNativeCompactUserSetAt = Date.now();
          } else {
            delete meta.claudeNativeCompactUserSetAt;
          }
        }
        if (msg.claudeNativeForceInterleavedThinkingBeta !== undefined) meta.claudeNativeForceInterleavedThinkingBeta = msg.claudeNativeForceInterleavedThinkingBeta;
        if (msg.claudeNativeThinkingDisplay !== undefined) meta.claudeNativeThinkingDisplay = msg.claudeNativeThinkingDisplay;
        if (msg.nativeCompactAutoContinue !== undefined) meta.nativeCompactAutoContinue = msg.nativeCompactAutoContinue;
        if (msg.efficiencyToolFilter !== undefined) meta.efficiencyToolFilter = msg.efficiencyToolFilter;
        if (msg.efficiencyFactForce !== undefined) meta.efficiencyFactForce = msg.efficiencyFactForce;
        if (msg.efficiencyConfigProtection !== undefined) meta.efficiencyConfigProtection = msg.efficiencyConfigProtection;
        if (msg.efficiencySandbox !== undefined) meta.efficiencySandbox = msg.efficiencySandbox;
        if (msg.reviewSafeMode !== undefined) meta.reviewSafeMode = msg.reviewSafeMode;
        if (msg.outputStyle !== undefined) {
          // Legacy `'caveman'` from a stale client → store `'terse'` on disk.
          meta.outputStyle = (msg.outputStyle as string) === 'caveman' ? 'terse' : msg.outputStyle;
        }
        if (msg.goal !== undefined) {
          // Mirror the wf.config decision above: capped text persists, blank clears.
          const capped = capGoal(msg.goal);
          if (capped) meta.goal = capped;
          else delete meta.goal;
        }
        if (msg.pinnedSkills !== undefined) {
          if (wf.config.pinnedSkills?.length) {
            meta.pinnedSkills = wf.config.pinnedSkills.map((s) => ({ ...s }));
          } else {
            delete meta.pinnedSkills;
          }
        }
        if (msg.remoteEnabled !== undefined) meta.remoteEnabled = msg.remoteEnabled;
        if (msg.remoteGatesEnabled !== undefined) meta.remoteGatesEnabled = msg.remoteGatesEnabled;
        if (msg.ollamaParams !== undefined) meta.ollamaParams = msg.ollamaParams;
        meta.lastActiveAt = Date.now();
      });
    } catch (err) {
      console.error(`[archon] [${msg.workflowId.slice(0, 8)}] update_primary_config meta write failed:`, err);
    }
  }

  // Persist-then-announce (see the north-star note above): the meta.json write
  // is durable now, so emit the goal_set event. Fires even if cwd was absent or
  // the write threw (caught + logged) — the in-memory value still changed.
  if (goalBroadcast) {
    broadcastWorkflow(msg.workflowId, {
      type: 'goal_set',
      workflowId: msg.workflowId,
      goal: goalBroadcast.goal,
      byteLen: goalBroadcast.byteLen,
    });
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] north-star ${goalBroadcast.goal ? `set → ${goalBroadcast.byteLen}B` : 'cleared'}`);
  }
  if (goalRunBroadcast) {
    broadcastWorkflow(msg.workflowId, {
      type: 'goal_run_state',
      workflowId: msg.workflowId,
      ...goalRunBroadcast,
    });
    broadcastWorkflow(msg.workflowId, {
      type: 'system_notice',
      workflowId: msg.workflowId,
      content: goalRunBroadcast.enabled
        ? `[GOAL RUN] Armed for ${goalRunBroadcast.total} iteration${goalRunBroadcast.total === 1 ? '' : 's'} toward the north star. ` +
          `A continuation turn fires after each settled turn; \`/goal run stop\` (or the chip) stops it.`
        : '[GOAL RUN] Disarmed. No further automatic turns.',
    });
  }
  if (pinnedSkillsBroadcast) {
    broadcastWorkflow(msg.workflowId, {
      type: 'pinned_skills_set',
      workflowId: msg.workflowId,
      ...pinnedSkillsBroadcast,
    });
    console.log(
      `[archon] [${msg.workflowId.slice(0, 8)}] pinned skills → ${pinnedSkillsBroadcast.skills.length} active (${pinnedSkillsBroadcast.bytes}B)` +
      (pinnedSkillsBroadcast.missing.length ? `; skipped ${pinnedSkillsBroadcast.missing.join(', ')}` : ''),
    );
  }

  // A remote-opt-in flip changes both the hub snapshot (this workflow now
  // appears/disappears in the VPS console) and the header monitored-count.
  // Re-push + re-broadcast at once. No-op when no hub is configured.
  if (remoteEnabledChanged) refreshHubReporting();

  // Mirrored browsers (server/src/workspace.ts) applied nothing locally — the
  // originating browser updated its job optimistically. Ship the resolved
  // config so every observer's CONFIG tab converges. Skipped for a
  // boot-materialized placeholder (missing client-only fields) until a
  // browser's rehydrate upgrades it. Transient (not in events.jsonl): a stale
  // config replayed after later non-config edits would regress the job; a
  // reconnecting browser takes the live config from workspace_snapshot instead.
  if (!wf.bootMaterialized) {
    broadcastTransient(msg.workflowId, { type: 'workflow_config_synced', workflowId: msg.workflowId, config: wf.config });
  }

  console.log(`[archon] [${msg.workflowId.slice(0, 8)}] primary updated → ${wf.primary.provider}:${wf.primary.model}@${wf.primary.effort}`);
}
