// Mobile view (docs/CLIENT.md "Mobile view"): the /mobile address. A directory
// of tabs (clusters fold open to their members), then one conversation under a
// short header with a member strip and a one-line question opener; STOP is
// in the composer's thumb row.
// PANELS opens a hub of the tab's own panels and the workbench-wide places;
// each opens full screen and ends with a button back to the conversation.
// The phone's Back button or gesture closes the top layer. Nothing here adds a
// function: every action routes to an existing store action, panel or dialog,
// and the conversation (transcript, composer, questions) is the desktop one.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAppStore, type JobState } from '../stores/appStore';
import { mobileBackStep, mobileDepth, usePhoneStore, type MobileLayers, type PhoneSheet } from '../stores/phoneStore';
import { useNotificationStore, unreadCount } from '../stores/notificationStore';
import { useTerminalStore } from '../stores/terminalStore';
import { clusterDisplayName } from './TabBar';
import { standaloneTabJobs } from '../utils/homeModel';
import { hasWaitingQuestion } from '../questions/waitingQuestion';
import { focusNoticeWorkflow } from '../alerts/focusNotice';
import { useTerminalTarget } from '../hooks/useTerminalTarget';
import { usePhoneOverlay } from '../layout/phoneOverlay';
import { PendingQuestionsList, pendingGates, usePendingQuestions } from './PendingQuestionsButton';
import { MOBILE_TEXT_SIZES, readMobileTextSize, writeMobileTextSize } from '../themes/bootstrap';
import { openArchive } from '../explorer/launch';
import { CatchMeUp } from './CatchMeUp';
import { openMediaStudio } from './media/launchers';
import { isClusterDirector, type ClusterStatePayload } from '@arco/shared';

const control = {
  minHeight: '44px', minWidth: '44px', padding: '0 12px', fontSize: '12px', letterSpacing: '0.5px', cursor: 'pointer',
  background: 'transparent', color: 'var(--color-fg)', border: '1px solid var(--color-border-hairline)', borderRadius: '4px',
  whiteSpace: 'nowrap' as const, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
};
// Text that carries meaning uses the theme's full foreground colour in bold:
// the theme fonts' thin strokes render lighter than their colour, and bold
// keeps small labels at 4.5:1 or better on screen. Status keeps its colour on
// the shape (StateMark) and borders.
const sectionHeading = { fontSize: '12px', letterSpacing: '1px', color: 'var(--color-fg)', padding: '14px 14px 6px', fontWeight: 700 } as const;

export interface PhoneViewport {
  // The on-screen keyboard is open: an input has focus and the visible height
  // dropped below what this width showed before.
  keyboard: boolean;
  // Little height to spare (keyboard open, or a phone turned sideways):
  // optional composer rows fold and the header takes one row.
  compact: boolean;
}

/** Keeps the app inside the visible area while the phone keyboard is open, and
 * reports how much room is left. iPhone Safari never resizes the page for the
 * keyboard, so the visual viewport is the measure on every browser. */
export function usePhoneViewport(active: boolean): PhoneViewport {
  const [state, setState] = useState<PhoneViewport>({ keyboard: false, compact: false });
  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    const clear = () => {
      root.style.removeProperty('--phone-vh');
      root.style.removeProperty('--phone-vt');
    };
    if (!active || !vv) {
      clear();
      setState({ keyboard: false, compact: false });
      return;
    }
    const tallest = new Map<number, number>();
    const update = () => {
      root.style.setProperty('--phone-vh', `${Math.round(vv.height)}px`);
      root.style.setProperty('--phone-vt', `${Math.round(vv.offsetTop)}px`);
      const width = Math.round(window.innerWidth);
      const editing = (() => {
        const el = document.activeElement as HTMLElement | null;
        return !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'checkbox') || el.isContentEditable);
      })();
      const top = Math.max(tallest.get(width) ?? 0, editing ? 0 : vv.height);
      if (top) tallest.set(width, top);
      const keyboard = editing && !!top && vv.height < top * 0.85;
      const compact = keyboard || vv.height < 500;
      setState((prev) => (prev.keyboard === keyboard && prev.compact === compact ? prev : { keyboard, compact }));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
      clear();
    };
  }, [active]);
  return state;
}

type MemberState = 'NEEDS YOU' | 'WORKING' | 'IDLE';

/** What a conversation waits on the operator for, if anything: a question
 * (Arco or Claude Native, including a sub-agent batch approval) or a parked
 * review gate. */
function decisionKind(job: JobState | undefined): string | null {
  if (!job) return null;
  if (pendingGates(job.messages).length > 0) return 'Approval waiting';
  return hasWaitingQuestion(job) ? 'Question waiting' : null;
}

function memberBusy(cluster: ClusterStatePayload, workflowId: string, job: JobState | undefined): boolean {
  return cluster.members.find((m) => m.workflowId === workflowId)?.status === 'busy' || !!job?.busy;
}

function memberState(cluster: ClusterStatePayload, workflowId: string, job: JobState | undefined): MemberState {
  const busy = memberBusy(cluster, workflowId, job);
  const mail = cluster.mailboxDepth?.[workflowId] ?? 0;
  if (decisionKind(job) || (mail > 0 && !busy)) return 'NEEDS YOU';
  return busy ? 'WORKING' : 'IDLE';
}

function jobState(job: JobState | undefined): MemberState {
  if (decisionKind(job)) return 'NEEDS YOU';
  return job?.busy ? 'WORKING' : 'IDLE';
}

function needYou(n: number): string {
  return `${n} ${n === 1 ? 'needs' : 'need'} you`;
}

/** The state text: a conversation that needs the operator while it still
 * works says both. */
function stateText(state: MemberState, busy: boolean): string {
  return state === 'NEEDS YOU' && busy ? 'NEEDS YOU \u00B7 WORKING' : state;
}

function stateColor(state: MemberState): string {
  return state === 'NEEDS YOU' ? 'var(--color-warning)' : state === 'WORKING' ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)';
}

interface Shown { workflowId: string | null; label: string; clusterId: string | null; clusterName: string; kind: string }

function useShownConversation(): Shown {
  const jobs = useAppStore((s) => s.jobs);
  const clusters = useAppStore((s) => s.clusters);
  const activeClusterId = useAppStore((s) => s.activeClusterId);
  const activeJobId = useAppStore((s) => s.activeJobId);
  const focused = useAppStore((s) => s.clusterFocusedMember);
  const showHome = useAppStore((s) => s.showHome);
  const showGithub = useAppStore((s) => s.showGithub);
  const showCreator = useAppStore((s) => s.showCreator);
  if (showHome || showGithub || showCreator) {
    const label = showHome ? 'Home' : showGithub ? 'GitHub' : 'New tab';
    return { workflowId: null, label, clusterId: null, clusterName: '', kind: 'Workbench' };
  }
  if (activeClusterId && clusters[activeClusterId]) {
    const cluster = clusters[activeClusterId];
    const member = cluster.research?.quick ? cluster.members.find((m) => m.workflowId === cluster.research?.directorWorkflowId) : cluster.members.find((m) => m.workflowId === focused[activeClusterId]) ?? cluster.members[0];
    const name = clusterDisplayName(cluster);
    return { workflowId: member?.workflowId ?? null, label: cluster.research?.quick ? cluster.research.name : member?.displayName ?? name, clusterId: activeClusterId, clusterName: name, kind: cluster.research?.quick ? 'Quick research' : cluster.research ? 'Research project' : 'Cluster' };
  }
  const job = activeJobId ? jobs[activeJobId] : undefined;
  const name = job?.config.name || (activeJobId ? activeJobId.slice(0, 8) : 'Arco');
  return { workflowId: job ? job.id : null, label: name, clusterId: null, clusterName: '', kind: job?.config.kind === 'chat' ? 'Chat' : 'Agent' };
}

/** Counts across every open tab: conversations working, and those waiting on the operator. */
function useWorkbenchCounts(): { working: number; needs: number } {
  const jobs = useAppStore((s) => s.jobs);
  const clusters = useAppStore((s) => s.clusters);
  return useMemo(() => {
    let working = 0;
    let needs = 0;
    const tabJobs = Object.values(jobs).filter((j) => !j.config.voiceOperator && (!j.parentWorkflowId || j.promoted === true));
    for (const job of standaloneTabJobs(tabJobs, Object.values(clusters))) {
      if (job.busy) working += 1;
      if (jobState(job) === 'NEEDS YOU') needs += 1;
    }
    for (const cluster of Object.values(clusters)) {
      for (const m of cluster.members) {
        const job = jobs[m.workflowId];
        if (m.status === 'busy' || job?.busy) working += 1;
        if (memberState(cluster, m.workflowId, job) === 'NEEDS YOU') needs += 1;
      }
    }
    return { working, needs };
  }, [jobs, clusters]);
}

/** The header's back button: straight to the directory, closing whatever is
 * open over the conversation (the history entries are dropped to match). */
function leaveConversation(): void {
  const phone = usePhoneStore.getState();
  phone.openSheet(null);
  closeMobileDialogs();
  if (useAppStore.getState().showSettings) useAppStore.getState().setShowSettings(false);
  if (phone.openPanel) phone.closePanels();
  // Closing a terminal window keeps its shell running.
  const terminal = useTerminalStore.getState();
  for (const w of terminal.windows) terminal.closeWindow(w.windowId);
  phone.setScreen('directory');
}

/** A member chip always shows its member: whatever sits over the conversation
 * under the header (a sheet, a panel, the terminal window) closes. */
function showConversation(): void {
  const phone = usePhoneStore.getState();
  phone.openSheet(null);
  if (phone.openPanel) phone.closePanels();
  // Closing a terminal window keeps its shell running.
  const terminal = useTerminalStore.getState();
  for (const w of terminal.windows) terminal.closeWindow(w.windowId);
}

/** Close the full-screen workbench dialogs opened from PANELS. */
function closeMobileDialogs(): void {
  const app = useAppStore.getState();
  if (app.showManual) app.setShowManual(false);
  if (app.showRecall) app.setShowRecall(false);
  if (app.mediaStudio.open) app.setMediaStudio({ open: false });
  usePhoneStore.getState().setSystemOpen(false);
}

function openConversation(open: () => void): void {
  usePhoneStore.getState().openSheet(null);
  open();
  usePhoneStore.getState().setScreen('conversation');
}

/** The browser history follows the layers, so Back closes the top one. */
function useMobileHistory(): void {
  const screen = usePhoneStore((s) => s.screen);
  const sheet = usePhoneStore((s) => s.sheet);
  const localDialog = usePhoneStore((s) => s.localDialog);
  const openPanel = usePhoneStore((s) => s.openPanel);
  const settings = useAppStore((s) => s.showSettings);
  const manual = useAppStore((s) => s.showManual);
  const recall = useAppStore((s) => s.showRecall);
  const system = usePhoneStore((s) => s.systemOpen);
  const media = useAppStore((s) => s.mediaStudio.open);
  const settingsPage = usePhoneStore((s) => s.settingsPage);
  const terminal = useTerminalStore((s) => s.windows.length > 0);
  const layers: MobileLayers = { localDialog: !!localDialog, sheet: !!sheet, dialog: manual || recall || system || media, settingsPage, settings, terminal, panel: !!openPanel, conversation: screen === 'conversation' };
  const depth = mobileDepth(layers);
  const shown = useRef(0);
  const ignore = useRef(0);
  const layersRef = useRef(layers);
  layersRef.current = layers;
  useEffect(() => {
    if (depth > shown.current) {
      for (let d = shown.current + 1; d <= depth; d++) window.history.pushState({ arcoMobile: d }, '');
    } else if (depth < shown.current) {
      // Closed in the page (a button, Escape): drop the matching entries.
      ignore.current += 1;
      window.history.go(depth - shown.current);
    }
    shown.current = depth;
  }, [depth]);
  useEffect(() => {
    const onPop = () => {
      if (ignore.current > 0) { ignore.current -= 1; return; }
      const step = mobileBackStep(layersRef.current);
      if (!step) return;
      shown.current = Math.max(0, shown.current - 1);
      if (step === 'localDialog') usePhoneStore.getState().localDialog?.();
      else if (step === 'sheet') usePhoneStore.getState().openSheet(null);
      else if (step === 'dialog') closeMobileDialogs();
      else if (step === 'settingsPage') usePhoneStore.getState().setSettingsPage(false);
      else if (step === 'settings') useAppStore.getState().setShowSettings(false);
      else if (step === 'terminal') { const t = useTerminalStore.getState(); for (const w of t.windows) t.closeWindow(w.windowId); }
      else if (step === 'panel') usePhoneStore.getState().closePanels();
      else usePhoneStore.getState().setScreen('directory');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
}

export function MobileHeader({ viewport }: { viewport: PhoneViewport }) {
  useMobileHistory();
  const shown = useShownConversation();
  const screen = usePhoneStore((s) => s.screen);
  const sheet = usePhoneStore((s) => s.sheet);
  const openSheet = usePhoneStore((s) => s.openSheet);
  const jobs = useAppStore((s) => s.jobs);
  const clusters = useAppStore((s) => s.clusters);
  const counts = useWorkbenchCounts();
  const questions = usePendingQuestions(shown.workflowId ?? '', true);
  const busy = !!(shown.workflowId && jobs[shown.workflowId]?.busy);
  useEffect(() => { usePhoneStore.getState().setReturnLabel(shown.label); }, [shown.label]);
  // Floating windows (the terminal) start below this header so STOP and Back stay in reach.
  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty('--phone-header-h', `${el.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => { observer.disconnect(); root.style.removeProperty('--phone-header-h'); };
  }, []);
  const toggle = (next: PhoneSheet) => openSheet(sheet === next ? null : next);
  const cluster = shown.clusterId ? clusters[shown.clusterId] : undefined;
  // Little height (sideways, or the keyboard open): one row. The member strip
  // folds into the title, which opens the members sheet, and the question
  // line becomes one button in the row.
  const oneRow = viewport.compact;
  const switchable = !!cluster && !cluster.research?.quick;
  const titleSwitches = switchable && oneRow;
  const headerStyle = {
    flexShrink: 0, display: 'flex', flexDirection: 'column' as const, gap: '6px', position: 'relative' as const, zIndex: 10,
    padding: 'calc(6px + env(safe-area-inset-top)) calc(10px + env(safe-area-inset-right)) 6px calc(10px + env(safe-area-inset-left))',
    background: 'var(--color-bg-panel)', borderBottom: '1px solid var(--color-border-hairline)',
  };
  const panelsButton = (
    <button type="button" data-testid="phone-panels" data-help="mobile.panels" onClick={() => toggle('panels')} aria-pressed={sheet === 'panels'} aria-label="Panels" title="Panels" className="display-font" style={{ ...control, padding: 0 }}>
      <span aria-hidden="true" style={{ fontSize: '18px' }}>{'\u2630'}</span>
    </button>
  );

  if (screen === 'directory') {
    return (
      <header ref={headerRef} data-testid="phone-header" data-help="mobile.header" style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: '44px' }}>
          <span className="display-font glow-text-bright" style={{ fontSize: '16px', letterSpacing: '4px', color: 'var(--color-accent-primary)' }}>ARCO</span>
          <span data-testid="mobile-counts" className="display-font" style={{ flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 700, color: 'var(--color-fg)', textAlign: 'right' }}>
            <span>{counts.working} working</span>
            {' \u00B7 '}
            <span>{counts.needs ? <span aria-hidden="true" style={{ color: 'var(--color-warning)' }}>{'\u25B2 '}</span> : null}{needYou(counts.needs)}</span>
          </span>
          {panelsButton}
        </div>
      </header>
    );
  }

  const state: MemberState = cluster && shown.workflowId ? memberState(cluster, shown.workflowId, jobs[shown.workflowId]) : jobState(shown.workflowId ? jobs[shown.workflowId] : undefined);
  const firstQuestion = (() => {
    const q = questions.pending[0]?.operatorQuestion?.questions[0];
    if (q) return q.question || q.header;
    if (questions.asks[0]) return questions.asks[0].ask.question;
    const gate = questions.gates[0]?.toolUse?.input as Record<string, unknown> | undefined;
    return gate ? `Approve ${String(gate.toolName ?? 'a tool call')}?` : '';
  })();
  const typing = viewport.keyboard;
  const decisionLabel = questions.count > 1 ? `${questions.count} WAITING` : questions.gates.length ? 'APPROVAL' : 'QUESTION';
  const decisionAria = `${questions.count === 1 ? 'A decision is' : `${questions.count} decisions are`} waiting: ${firstQuestion}`;
  return (
    <header ref={headerRef} data-testid="phone-header" data-help="mobile.header" data-phone-header-mode={typing ? 'typing' : oneRow ? 'row' : 'full'} style={headerStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
        <button type="button" data-testid="mobile-back" data-help="mobile.back" onClick={leaveConversation}
          aria-label={counts.needs ? `Back to tabs, ${needYou(counts.needs)}` : 'Back to tabs'} className="display-font" style={{ ...control, padding: '0 8px', fontSize: '18px' }}>
          {'\u2039'}{counts.needs ? <span style={{ fontSize: '12px', color: 'var(--color-fg)' }}><span aria-hidden="true" style={{ color: 'var(--color-warning)' }}>{'\u25B2'}</span>{counts.needs}</span> : null}
        </button>
        {/* The identity gets the row's free width: who STOP and a message reach.
            It is a plain label while the member strip is on screen, so a cluster
            has one member switcher; with the strip folded away (one row) it is
            the button that lists the members. */}
        {(() => {
          const titleStyle = { flex: 1, minWidth: 0, minHeight: '44px', display: 'flex', flexDirection: 'column' as const, justifyContent: 'center', textAlign: 'left' as const, background: 'transparent', border: 0, padding: '0 2px', color: 'var(--color-fg)' };
          const lines = <>
            <span className="display-font" style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', fontWeight: 700, letterSpacing: '0.5px', color: 'var(--color-fg)', minWidth: 0, whiteSpace: 'nowrap' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{cluster ? shown.clusterName : shown.kind}</span>
              {shown.workflowId && <span style={{ flexShrink: 0, display: 'inline-flex', gap: '2px' }}><StateMark state={state} />{stateText(state, busy)}</span>}
            </span>
            <span data-testid="phone-title-name" style={{ display: 'block', fontSize: oneRow ? '16px' : '18px', lineHeight: 1.25, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-body)' }}>
              {shown.label}{titleSwitches ? ' \u25BE' : ''}{cluster?.research?.quick ? ' · Research Director' : ''}
            </span>
          </>;
          return titleSwitches
            ? <button type="button" data-testid="phone-title" data-help="mobile.title" onClick={() => toggle('members')} aria-expanded={sheet === 'members'}
                aria-label={`${shown.label} in ${shown.clusterName}, ${stateText(state, busy).toLowerCase()}: switch member`} style={{ ...titleStyle, cursor: 'pointer' }}>{lines}</button>
            : <div data-testid="phone-title" data-help="mobile.title" style={titleStyle}>{lines}</div>;
        })()}
        {oneRow && questions.count > 0 && shown.workflowId && (
          <button type="button" data-testid="mobile-question" data-help="mobile.question" onClick={() => toggle('questions')} aria-label={decisionAria}
            className="display-font" style={{ ...control, padding: '0 8px', borderColor: 'var(--color-warning)', borderWidth: '2px' }}>
            <span aria-hidden="true" style={{ color: 'var(--color-warning)' }}>{'\u25B2'}</span>{questions.count}
          </button>
        )}
        {!typing && panelsButton}
      </div>
      {!oneRow && questions.count > 0 && shown.workflowId && (
        <button type="button" data-testid="mobile-question" data-help="mobile.question" onClick={() => toggle('questions')} aria-label={decisionAria}
          style={{ ...control, width: '100%', justifyContent: 'flex-start', color: 'var(--color-fg)', borderColor: 'var(--color-warning)', borderWidth: '2px', overflow: 'hidden' }}>
          <span className="display-font" style={{ flexShrink: 0 }}><span aria-hidden="true" style={{ color: 'var(--color-warning)' }}>{'\u25B2'}</span> {decisionLabel}</span>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'var(--font-body)', fontSize: '14px', letterSpacing: 0, color: 'var(--color-fg)' }}>{firstQuestion}</span>
        </button>
      )}
      {switchable && !oneRow && <MemberStrip cluster={cluster} current={shown.workflowId} />}
    </header>
  );
}

function MemberStrip({ cluster, current }: { cluster: ClusterStatePayload; current: string | null }) {
  const jobs = useAppStore((s) => s.jobs);
  const setFocused = useAppStore((s) => s.setClusterFocusedMember);
  // The current member's chip stays in view after switching.
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current]);
  return (
    <div ref={stripRef} role="tablist" aria-label={`Members of ${clusterDisplayName(cluster)}`} data-testid="mobile-member-strip" data-help="mobile.members"
      style={{ display: 'flex', gap: '6px', overflowX: 'auto', scrollbarWidth: 'none', margin: '0 -10px', padding: '0 10px' }}>
      {cluster.members.map((m) => {
        const state = memberState(cluster, m.workflowId, jobs[m.workflowId]);
        const mail = cluster.mailboxDepth?.[m.workflowId] ?? 0;
        const selected = m.workflowId === current;
        return (
          <button key={m.workflowId} type="button" role="tab" aria-selected={selected} data-testid="mobile-member"
            aria-label={`${m.displayName}: ${state.toLowerCase()}${mail ? `, ${mail} unread mail` : ''}`}
            onClick={() => { setFocused(cluster.clusterId, m.workflowId); showConversation(); }}
            style={{ ...control, flexShrink: 0, borderRadius: '22px', fontSize: '14px', letterSpacing: 0, fontFamily: 'var(--font-body)',
              background: selected ? 'var(--color-accent-primary-a10)' : 'transparent', borderColor: selected ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)' }}>
            <StateMark state={state} />
            {m.displayName}
            {state !== 'IDLE' && <span className="display-font" style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.5px', color: 'var(--color-fg)' }}>{state === 'NEEDS YOU' ? 'NEEDS YOU' : 'WORKING'}</span>}
            {mail > 0 && <span className="display-font" style={{ fontSize: '11px', color: 'var(--color-accent-secondary)' }}>{`\u2709${mail}`}</span>}
          </button>
        );
      })}
    </div>
  );
}

function StateMark({ state }: { state: MemberState }) {
  // Shape as well as colour: a triangle needs you, a bar works, a dot is idle.
  const glyph = state === 'NEEDS YOU' ? '\u25B2' : state === 'WORKING' ? '\u25AE' : '\u00B7';
  return <span aria-hidden="true" style={{ color: stateColor(state), fontSize: '12px', width: '1em', textAlign: 'center', flexShrink: 0 }}>{glyph}</span>;
}

const rowStyle = (indent: boolean, current: boolean) => ({
  display: 'flex', alignItems: 'center', gap: '10px', width: '100%', minHeight: '56px',
  padding: `6px calc(14px + env(safe-area-inset-right)) 6px calc(${indent ? 30 : 14}px + env(safe-area-inset-left))`, textAlign: 'left' as const, cursor: 'pointer',
  background: current ? 'var(--color-accent-primary-a08)' : 'transparent', color: 'var(--color-fg)', border: 0, borderBottom: '1px solid var(--color-border-hairline)', borderRadius: 0,
});

function Row({ onClick, label, detail, state, busy = false, current = false, testId, indent = false }: { onClick: () => void; label: string; detail?: string; state?: MemberState; busy?: boolean; current?: boolean; testId?: string; indent?: boolean }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId} aria-current={current ? 'page' : undefined}
      aria-label={`${label}${detail ? `, ${detail}` : ''}${state ? `: ${stateText(state, busy).toLowerCase()}` : ''}`} style={rowStyle(indent, current)}>
      {state && <StateMark state={state} />}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: '16px', fontFamily: 'var(--font-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {detail && <span className="display-font" style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--color-fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</span>}
      </span>
      {state && <span className="display-font" style={{ flexShrink: 0, fontSize: '12px', fontWeight: 700, letterSpacing: '0.5px', color: 'var(--color-fg)', textAlign: 'right' }}>{stateText(state, busy)}</span>}
    </button>
  );
}

/** The first screen: what needs the operator, then every open tab. */
export function MobileDirectory() {
  const jobs = useAppStore((s) => s.jobs);
  const clusters = useAppStore((s) => s.clusters);
  const order = useAppStore((s) => s.settings?.tabOrder);
  const activeClusterId = useAppStore((s) => s.activeClusterId);
  const activeJobId = useAppStore((s) => s.activeJobId);
  const focused = useAppStore((s) => s.clusterFocusedMember);
  const [open, setOpen] = useState<Record<string, boolean>>(() => usePhoneStore.getState().directoryOpen ?? (activeClusterId ? { [activeClusterId]: true } : {}));
  const store = useAppStore.getState;
  const rank = useMemo(() => new Map((order ?? []).map((id, i) => [id, i])), [order]);
  const byOrder = <T,>(items: T[], id: (item: T) => string) => [...items].sort((a, b) => (rank.get(id(a)) ?? 1e9) - (rank.get(id(b)) ?? 1e9));
  const tabJobs = useMemo(() => {
    const all = Object.values(jobs).filter((j) => !j.config.voiceOperator && (!j.parentWorkflowId || j.promoted === true));
    return standaloneTabJobs(all, Object.values(clusters));
  }, [jobs, clusters]);
  const agents = byOrder(tabJobs.filter((j) => j.config.kind !== 'chat'), (j) => j.id);
  const chats = byOrder(tabJobs.filter((j) => j.config.kind === 'chat'), (j) => j.id);
  const clusterList = byOrder(Object.values(clusters), (c) => c.clusterId);
  const ordinaryClusters = clusterList.filter(c => !c.research);
  const researchProjects = clusterList.filter(c => c.research && !c.research.quick);
  const quickResearch = clusterList.filter(c => c.research?.quick);
  const needs = [
    ...clusterList.flatMap((c) => c.members.filter((m) => memberState(c, m.workflowId, jobs[m.workflowId]) === 'NEEDS YOU').map((m) => ({
      id: m.workflowId, label: m.displayName, where: clusterDisplayName(c), busy: memberBusy(c, m.workflowId, jobs[m.workflowId]),
      decision: !!decisionKind(jobs[m.workflowId]), why: decisionKind(jobs[m.workflowId]) ?? 'Idle with unread mail',
    }))),
    ...[...agents, ...chats].filter((j) => decisionKind(j)).map((j) => ({ id: j.id, label: j.config.name || j.id.slice(0, 8), where: j.config.kind === 'chat' ? 'Chat' : 'Agent', busy: !!j.busy, decision: true, why: decisionKind(j)! })),
  ];
  const provider = (j: JobState) => String(j.config.primaryProvider ?? '').toUpperCase();
  // The conversation stays mounted underneath (its draft is kept) but cannot
  // take focus or touch while the directory covers it.
  const dirRef = useRef<HTMLDivElement>(null);
  usePhoneOverlay(dirRef, true);
  // Keep the open clusters and the scroll position for the next return.
  const openRef = useRef(open);
  openRef.current = open;
  useLayoutEffect(() => {
    const el = dirRef.current;
    if (el) el.scrollTop = usePhoneStore.getState().directoryScroll;
    return () => usePhoneStore.getState().setDirectoryView(openRef.current, el?.scrollTop ?? 0);
  }, []);
  return (
    <div ref={dirRef} data-testid="mobile-directory" data-help="mobile.directory" style={{ position: 'absolute', inset: 0, zIndex: 30, overflowY: 'auto', background: 'var(--color-bg)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {needs.length > 0 && <>
        <div className="display-font" style={sectionHeading}><span aria-hidden="true" style={{ color: 'var(--color-warning)' }}>{'\u25B2'}</span> NEEDS YOU ({needs.length})</div>
        {needs.map((n) => (
          <Row key={`needs-${n.id}`} testId="mobile-needs" label={`${n.label} \u00B7 ${n.where}`} detail={n.why} state="NEEDS YOU" busy={n.busy}
            onClick={() => { openConversation(() => focusNoticeWorkflow(n.id)); if (n.decision) usePhoneStore.getState().openSheet('questions', n.id); }} />
        ))}
      </>}
      {ordinaryClusters.length > 0 && <div className="display-font" style={sectionHeading}>CLUSTERS</div>}
      {ordinaryClusters.map((c) => {
        const states = c.members.map((m) => memberState(c, m.workflowId, jobs[m.workflowId]));
        const working = c.members.filter((m) => m.status === 'busy' || jobs[m.workflowId]?.busy).length;
        const waiting = states.filter((s) => s === 'NEEDS YOU').length;
        const expanded = !!open[c.clusterId];
        // Where the row opens: the member last in view, else the Director.
        const last = focused[c.clusterId];
        const target = (last && c.members.some((m) => m.workflowId === last) ? last : undefined)
          ?? c.members.find((m) => isClusterDirector(m.role))?.workflowId ?? c.members[0]?.workflowId;
        const current = activeClusterId === c.clusterId && !expanded;
        return (
          <div key={c.clusterId}>
            {/* Two controls side by side: the row opens the cluster, as a
                research project's row does; MEMBERS folds its list open. */}
            <div style={{ display: 'flex', alignItems: 'stretch', borderBottom: '1px solid var(--color-border-hairline)', background: current ? 'var(--color-accent-primary-a08)' : 'transparent' }}>
              <button type="button" data-testid="mobile-cluster" aria-current={current ? 'page' : undefined}
                onClick={() => openConversation(() => { store().setActiveCluster(c.clusterId); if (target) store().setClusterFocusedMember(c.clusterId, target); })}
                aria-label={`${clusterDisplayName(c)}: ${working} working, ${needYou(waiting)}`}
                style={{ ...rowStyle(false, false), flex: 1, minWidth: 0, width: 'auto', borderBottom: 0, paddingRight: '8px' }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: '16px', fontWeight: 600, fontFamily: 'var(--font-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{clusterDisplayName(c)}</span>
                  <span style={{ display: 'flex', gap: '2px', overflow: 'hidden' }} aria-hidden="true">{states.map((s, i) => <StateMark key={i} state={s} />)}</span>
                </span>
                <span className="display-font" style={{ flexShrink: 0, fontSize: '12px', textAlign: 'right', lineHeight: 1.4 }}>
                  <span style={{ display: 'block', color: 'var(--color-fg)', fontWeight: 700 }}>{working} working</span>
                  <span style={{ display: 'block', color: 'var(--color-fg)', fontWeight: 700 }}>{needYou(waiting)}</span>
                </span>
              </button>
              <button type="button" data-testid="mobile-cluster-members" data-help="mobile.cluster-members" aria-expanded={expanded} aria-controls={`mobile-members-${c.clusterId}`}
                onClick={() => setOpen((o) => ({ ...o, [c.clusterId]: !expanded }))}
                aria-label={`${expanded ? 'Hide' : 'Show'} members of ${clusterDisplayName(c)}`} className="display-font"
                style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '6px', minWidth: '44px', minHeight: '56px', padding: '6px calc(14px + env(safe-area-inset-right)) 6px 12px', background: 'transparent', color: 'var(--color-fg)', border: 0, borderLeft: '1px solid var(--color-border-hairline)', borderRadius: 0, fontSize: '12px', fontWeight: 700, letterSpacing: '0.5px', cursor: 'pointer' }}>
                MEMBERS<span aria-hidden="true" style={{ color: 'var(--color-accent-primary)', fontFamily: 'var(--font-body)' }}>{expanded ? '\u25BE' : '\u25B8'}</span>
              </button>
            </div>
            <div id={`mobile-members-${c.clusterId}`}>
            {expanded && c.members.map((m, i) => {
              const mail = c.mailboxDepth?.[m.workflowId] ?? 0;
              return (
                <Row key={m.workflowId} testId="mobile-cluster-member" indent label={m.displayName}
                  detail={[m.role ? m.role.split(/[.:]/)[0] : '', mail ? `${mail} unread mail` : ''].filter(Boolean).join(' \u00B7 ')}
                  state={states[i]} busy={memberBusy(c, m.workflowId, jobs[m.workflowId])} current={activeClusterId === c.clusterId && (focused[c.clusterId] ?? c.members[0]?.workflowId) === m.workflowId}
                  onClick={() => openConversation(() => { store().setActiveCluster(c.clusterId); store().setClusterFocusedMember(c.clusterId, m.workflowId); })} />
              );
            })}
            </div>
          </div>
        );
      })}
      {researchProjects.length > 0 && <div className="display-font" style={sectionHeading}>RESEARCH PROJECTS</div>}
      {researchProjects.map(c => <Row key={c.clusterId} testId="mobile-research-project" label={c.research!.name} detail={`${c.research!.rounds.length} rounds · ${needYou(c.members.filter(m => memberState(c, m.workflowId, jobs[m.workflowId]) === 'NEEDS YOU').length)}`} onClick={() => openConversation(() => { store().setActiveCluster(c.clusterId); store().setClusterFocusedMember(c.clusterId, c.research!.directorWorkflowId); })} />)}
      {agents.length > 0 && <div className="display-font" style={sectionHeading}>AGENTS</div>}
      {agents.map((j) => (
        <Row key={j.id} testId="mobile-tab" label={j.config.name || j.id.slice(0, 8)} detail={provider(j)} state={jobState(j)} busy={!!j.busy}
          current={!activeClusterId && activeJobId === j.id} onClick={() => openConversation(() => store().setActiveJob(j.id))} />
      ))}
      {(chats.length > 0 || quickResearch.length > 0) && <div className="display-font" style={sectionHeading}>CHATS</div>}
      {quickResearch.map(c => <Row key={c.clusterId} testId="mobile-quick-research" label={c.research!.name} detail={`Quick research · ${needYou(c.members.filter(m => memberState(c, m.workflowId, jobs[m.workflowId]) === 'NEEDS YOU').length)}`} onClick={() => openConversation(() => { store().setActiveCluster(c.clusterId); store().setClusterFocusedMember(c.clusterId, c.research!.directorWorkflowId); })} />)}
      {chats.map((j) => (
        <Row key={j.id} testId="mobile-tab" label={j.config.name || j.id.slice(0, 8)} detail={provider(j)} state={jobState(j)} busy={!!j.busy}
          current={!activeClusterId && activeJobId === j.id} onClick={() => openConversation(() => store().setActiveJob(j.id))} />
      ))}
      <div className="display-font" style={sectionHeading}>WORKBENCH</div>
      <Row testId="mobile-home" label="Home" detail="Projects and saved sessions" onClick={() => openConversation(() => store().showHomeView())} />
      <Row testId="mobile-new-tab" label="+ New tab" detail="Agent, cluster or chat" onClick={() => openConversation(() => store().showJobCreator())} />
    </div>
  );
}

function Sheet({ title, onClose, children, testId }: { title: string; onClose: () => void; children: ReactNode; testId?: string }) {
  // The one overlay over the conversation: focus starts inside it, the
  // conversation underneath cannot take focus, and closing returns focus to
  // the header button that opened it.
  const sheetRef = useRef<HTMLDivElement>(null);
  usePhoneOverlay(sheetRef, true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div ref={sheetRef} role="dialog" aria-label={title} data-testid={testId ?? 'phone-sheet'} style={{
      position: 'absolute', inset: 0, zIndex: 50, display: 'flex', flexDirection: 'column', minHeight: 0,
      background: 'var(--color-bg-dialog, var(--color-bg-panel))',
      paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', borderBottom: '1px solid var(--color-border-hairline)' }}>
        <h2 className="display-font" style={{ flex: 1, minWidth: 0, fontSize: '14px', letterSpacing: '1px', color: 'var(--color-fg)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</h2>
        <button type="button" data-testid="phone-sheet-back" onClick={onClose} className="display-font" style={control}>CLOSE</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{children}</div>
    </div>
  );
}

/** The directory, or the open sheet, drawn over the conversation area. */
export function MobileScreenHost() {
  const screen = usePhoneStore((s) => s.screen);
  const sheet = usePhoneStore((s) => s.sheet);
  const openSheet = usePhoneStore((s) => s.openSheet);
  const close = useMemo(() => () => openSheet(null), [openSheet]);
  return <>
    {screen === 'directory' && <MobileDirectory />}
    {sheet === 'members' && <MembersSheet onClose={close} />}
    {sheet === 'questions' && <QuestionsSheet onClose={close} />}
    {sheet === 'panels' && <PanelsSheet onClose={close} />}
  </>;
}

function MembersSheet({ onClose }: { onClose: () => void }) {
  const clusters = useAppStore((s) => s.clusters);
  const jobs = useAppStore((s) => s.jobs);
  const activeClusterId = useAppStore((s) => s.activeClusterId);
  const focused = useAppStore((s) => s.clusterFocusedMember);
  const setFocused = useAppStore((s) => s.setClusterFocusedMember);
  const cluster = activeClusterId ? clusters[activeClusterId] : undefined;
  if (!cluster) return <Sheet title="Members" onClose={onClose}><p style={{ padding: '14px' }}>No cluster is shown.</p></Sheet>;
  const current = focused[cluster.clusterId] ?? cluster.members[0]?.workflowId;
  return (
    <Sheet title={`Members of ${clusterDisplayName(cluster)}`} onClose={onClose}>
      {cluster.members.map((m) => {
        const mail = cluster.mailboxDepth?.[m.workflowId] ?? 0;
        const job = jobs[m.workflowId];
        return (
          <Row key={m.workflowId} testId="phone-member" label={m.displayName}
            detail={[m.role ? m.role.split(/[.:]/)[0] : '', String(job?.config.primaryProvider ?? '').toUpperCase(), mail ? `${mail} unread mail` : ''].filter(Boolean).join(' \u00B7 ')}
            state={memberState(cluster, m.workflowId, job)} busy={memberBusy(cluster, m.workflowId, job)} current={current === m.workflowId}
            onClick={() => { setFocused(cluster.clusterId, m.workflowId); onClose(); }} />
        );
      })}
    </Sheet>
  );
}

function QuestionsSheet({ onClose }: { onClose: () => void }) {
  const shown = useShownConversation();
  const owner = usePhoneStore((s) => s.questionWorkflowId) ?? shown.workflowId;
  const ownerName = useAppStore((s) => owner ? s.jobs[owner]?.config.name : undefined);
  const { count } = usePendingQuestions(owner ?? '', true);
  useEffect(() => { if (!count) onClose(); }, [count, onClose]);
  return (
    <Sheet title={`Waiting on you \u00B7 ${ownerName || shown.label}`} onClose={onClose} testId="mobile-questions">
      <div data-mobile-questions="" style={{ padding: '12px calc(14px + env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) calc(14px + env(safe-area-inset-left))' }}>
        {owner && <PendingQuestionsList workflowId={owner} all />}
      </div>
    </Sheet>
  );
}

function PanelsSheet({ onClose }: { onClose: () => void }) {
  const screen = usePhoneStore((s) => s.screen);
  const panels = usePhoneStore((s) => s.panels);
  const requestPanel = usePhoneStore((s) => s.requestPanel);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setShowManual = useAppStore((s) => s.setShowManual);
  const { workflowId: terminalWorkflowId, root: terminalRoot } = useTerminalTarget();
  const openTerminal = useTerminalStore((s) => s.openTerminal);
  const notices = useNotificationStore((s) => s.notices);
  const unread = useNotificationStore(unreadCount);
  const markAllSeen = useNotificationStore((s) => s.markAllSeen);
  const [showNotices, setShowNotices] = useState(false);
  const [size, setSize] = useState(readMobileTextSize);
  useEffect(() => { if (showNotices) markAllSeen(); }, [showNotices, markAllSeen, notices.length]);
  const shown = useShownConversation();
  const activeJob = useAppStore((s) => (s.activeJobId ? s.jobs[s.activeJobId] : undefined));
  // CATCH ME UP for the conversation shown (the workbench shows it above the chat).
  const catchUpScope = screen !== 'conversation' || !shown.workflowId ? null
    : shown.clusterId ? { kind: 'cluster' as const, id: shown.clusterId }
    : activeJob && !activeJob.config.incognito ? { kind: 'workflow' as const, id: activeJob.id } : null;
  const canTerminal = screen === 'conversation' && !!(terminalWorkflowId && terminalRoot);
  const tile = { ...control, minHeight: '52px', width: '100%', fontSize: '13px' };
  const tabPanels = screen === 'conversation' ? panels : [];
  const store = useAppStore.getState;
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '8px', padding: '0 calc(14px + env(safe-area-inset-right)) 0 calc(14px + env(safe-area-inset-left))' } as const;
  return (
    <Sheet title="Panels" onClose={onClose} testId="mobile-panels">
      {tabPanels.length > 0 && <>
        <div className="display-font" style={sectionHeading}>{shown.label.toUpperCase()}</div>
        <div style={grid}>
          {tabPanels.map((p) => (
            <button key={p.id} type="button" data-testid="phone-panel" className="display-font" style={tile} onClick={() => requestPanel(p.id)}>{p.label}</button>
          ))}
        </div>
      </>}
      <div className="display-font" style={sectionHeading}>WORKBENCH</div>
      <div style={grid}>
        {screen === 'conversation' && <button type="button" data-testid="phone-panel-terminal" className="display-font" style={{ ...tile, opacity: canTerminal ? 1 : 0.5 }} disabled={!canTerminal}
          title={canTerminal ? 'Open a terminal in this tab\'s project' : 'Open a tab with a project first'}
          onClick={() => { if (terminalWorkflowId && terminalRoot) { openTerminal({ workflowId: terminalWorkflowId }); onClose(); } }}>TERMINAL</button>}
        {catchUpScope && <div data-testid="mobile-panel-catch-up" style={{ display: 'contents' }}><CatchMeUp scope={catchUpScope} /></div>}
        <button type="button" data-testid="phone-panel-settings" className="display-font" style={tile} onClick={() => { onClose(); setShowSettings(true); }}>SETTINGS</button>
        <button type="button" data-testid="mobile-panel-home" className="display-font" style={tile} onClick={() => openConversation(() => store().showHomeView())}>HOME</button>
        <button type="button" data-testid="mobile-panel-new" className="display-font" style={tile} onClick={() => openConversation(() => store().showJobCreator())}>NEW TAB</button>
        <button type="button" data-testid="mobile-panel-notices" className="display-font" style={tile} aria-expanded={showNotices} onClick={() => setShowNotices((v) => !v)}>NOTICES{unread ? ` ${unread}` : ''}</button>
        <button type="button" data-testid="mobile-panel-manual" className="display-font" style={tile} onClick={() => { onClose(); setShowManual(true); }}>MANUAL</button>
        <button type="button" data-testid="mobile-panel-recall" data-help="header.recall" className="display-font" style={tile} onClick={() => { onClose(); store().setShowRecall(true); }}>RECALL</button>
        <button type="button" data-testid="mobile-panel-media" data-help="header.media" className="display-font" style={tile} onClick={() => { onClose(); openMediaStudio(); }}>MEDIA</button>
        <button type="button" data-testid="mobile-panel-system" data-help="mobile.system" className="display-font" style={tile} onClick={() => { onClose(); usePhoneStore.getState().setSystemOpen(true); }}>SYSTEM</button>
        <button type="button" data-testid="mobile-panel-plans" data-help="header.plans" className="display-font" style={tile} title="Opens in a new browser tab" onClick={() => { void openArchive('plans', terminalRoot ?? undefined); }}>ALL PLANS {'\u2197'}</button>
        <button type="button" data-testid="mobile-panel-artifacts" data-help="header.archive" className="display-font" style={tile} title="Opens in a new browser tab" onClick={() => { void openArchive(undefined, terminalRoot ?? undefined); }}>ARTIFACTS {'\u2197'}</button>
      </div>
      <p style={{ fontSize: '13px', color: 'var(--color-fg)', padding: '8px 14px 0', margin: 0 }}>{'\u2197'} opens in a new browser tab.</p>
      {showNotices && (
        <div data-testid="mobile-notices" style={{ padding: '8px 0' }}>
          {notices.length === 0 && <p style={{ fontSize: '14px', color: 'var(--color-fg)', padding: '0 14px' }}>No notices.</p>}
          {notices.map((n) => (
            n.workflowId
              ? <Row key={n.id} label={[n.title, n.body].filter(Boolean).join(': ')} onClick={() => openConversation(() => focusNoticeWorkflow(n.workflowId!))} />
              : <p key={n.id} style={{ fontSize: '14px', margin: '0 0 8px', padding: '0 14px', overflowWrap: 'anywhere' }}>{[n.title, n.body].filter(Boolean).join(': ')}</p>
          ))}
        </div>
      )}
      <div className="display-font" style={sectionHeading}>THIS PHONE</div>
      <div role="group" aria-label="Text size on this phone" data-help="mobile.text-size" style={{ display: 'flex', gap: '8px', padding: '0 14px', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '14px', marginRight: '4px' }}>Text size</span>
        {MOBILE_TEXT_SIZES.map((s) => (
          <button key={s} type="button" aria-pressed={size === s} data-testid="mobile-text-size" className="display-font"
            style={{ ...control, color: size === s ? 'var(--color-accent-primary)' : 'var(--color-fg)', borderColor: size === s ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)' }}
            onClick={() => { writeMobileTextSize(s); setSize(s); }}>{Math.round(s * 100)}%</button>
        ))}
      </div>
      <p style={{ fontSize: '13px', color: 'var(--color-fg)', padding: '12px 14px calc(16px + env(safe-area-inset-bottom))' }}>
        Colours follow the theme chosen in Settings, on the computer and here; the text brightness setting applies on the computer only.
      </p>
    </Sheet>
  );
}

/** On the desktop workbench in a phone-sized window: a link to /mobile. */
export function OpenMobileViewLink() {
  return (
    <a href="/mobile" data-testid="open-mobile-view" data-help="mobile.open" className="display-font"
      style={{ display: 'block', flexShrink: 0, padding: '12px', minHeight: '44px', textAlign: 'center', fontSize: '13px', letterSpacing: '0.5px',
        color: 'var(--color-accent-primary)', background: 'var(--color-bg-panel)', borderBottom: '1px solid var(--color-border-hairline)', textDecoration: 'none' }}>
      Open mobile view {'\u203A'}
    </a>
  );
}
