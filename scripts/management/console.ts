// arco-management §8 (K3) — the server-rendered mobile console.
//
// Server-rendered by the hub (operator decision 2026-06-03): the hub ships
// static HTML + CSS + a little vanilla JS; the phone's browser does all the
// rendering, so this is near-zero load on hub-host (no React bundle, no build
// step). The look lifts Arco's ACTUAL theme tokens (client/src/styles/
// global.css) — phosphor-green-on-near-black terminal aesthetic, mono fonts,
// sharp corners, hairline-green borders — so it reads as Arco, not an
// approximation. See docs/REMOTE_MANAGEMENT.md §8 "visual bar".
//
// Mobile-first: one-handed, large tap targets (≥44px), no hover-only behavior,
// current state above detail, sticky header. This v1 surfaces the INSTANCE +
// SERVICE-LIFECYCLE layer (Home screen) — workflow reply/stop/continue screens
// arrive once the workflow-reporting layer lands.

// Arco theme tokens, lifted verbatim from client/src/styles/global.css so the
// console matches the workbench rather than guessing.
const THEME_CSS = `
:root {
  --color-bg: #0c0e10;
  --color-bg-panel: rgba(8, 14, 10, 0.92);
  --color-bg-input: rgba(10, 16, 12, 0.95);
  --color-bg-elevated: rgba(14, 20, 16, 0.97);
  --color-bg-sunken: rgba(0, 10, 5, 0.5);
  --color-fg: #4af066;
  --color-fg-muted: rgba(74, 240, 102, 0.4);
  --color-accent-primary: #4af066;
  --color-accent-primary-dim: #2ecc52;
  --color-accent-primary-tint: #1a3a22;
  --color-accent-primary-glow: rgba(74, 240, 102, 0.2);
  --color-accent-secondary: #5ce0d6;
  --color-accent-secondary-bright: #8ef0e8;
  --color-border-hairline: rgba(74, 240, 102, 0.12);
  --color-border-bright: rgba(74, 240, 102, 0.3);
  --color-danger: #ff0040;
  --color-warning: #ffbf00;
  --color-success: #4af066;
  --font-display: 'Share Tech Mono', 'JetBrains Mono', ui-monospace, monospace;
  --font-body: 'JetBrains Mono', ui-monospace, monospace;
}`;

export function consoleCss(): string {
  return `${THEME_CSS}
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--color-bg);
  color: var(--color-accent-primary);
  font-family: var(--font-body);
  font-size: 15px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  /* faint phosphor vignette + scanlines for the Arco CRT feel */
  background-image:
    radial-gradient(120% 80% at 50% -10%, var(--color-accent-primary-glow), transparent 60%),
    repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0px, rgba(0,0,0,0.18) 1px, transparent 1px, transparent 3px);
  background-attachment: fixed;
  min-height: 100vh;
}
.wrap { max-width: 720px; margin: 0 auto; padding: 0 14px 40px; }

header {
  position: sticky; top: 0; z-index: 10;
  margin: 0 -14px 16px; padding: 16px 14px 12px;
  background: linear-gradient(var(--color-bg), rgba(12,14,16,0.85));
  backdrop-filter: blur(6px);
  border-bottom: 1px solid var(--color-border-hairline);
}
.title {
  font-family: var(--font-display);
  font-size: 20px; letter-spacing: 2px; text-transform: uppercase;
  color: var(--color-accent-primary);
  text-shadow: 0 0 10px var(--color-accent-primary-glow);
  display: flex; align-items: center; gap: 8px;
}
.title .diamond { color: var(--color-accent-secondary); }
.subtitle { color: var(--color-fg-muted); font-size: 12px; letter-spacing: 1px; margin-top: 2px; text-transform: uppercase; }

.card {
  background: var(--color-bg-panel);
  border: 1px solid var(--color-border-hairline);
  border-radius: 2px;
  padding: 14px; margin-bottom: 14px;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.4), inset 0 0 24px rgba(0,0,0,0.25);
}
.card.online { border-color: var(--color-border-bright); box-shadow: 0 0 16px var(--color-accent-primary-glow); }
.card.offline { opacity: 0.72; }

.card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.name { font-family: var(--font-display); font-size: 17px; letter-spacing: 1px; }
.badge {
  font-size: 11px; letter-spacing: 1px; text-transform: uppercase;
  padding: 3px 8px; border-radius: 2px; border: 1px solid currentColor; white-space: nowrap;
}
.badge.online  { color: var(--color-success); box-shadow: 0 0 8px var(--color-accent-primary-glow); }
.badge.stale   { color: var(--color-warning); }
.badge.offline { color: var(--color-danger); }

.meta { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 10px 0 4px; font-size: 13px; }
.meta dt { color: var(--color-fg-muted); text-transform: uppercase; letter-spacing: 0.5px; font-size: 11px; align-self: center; }
.meta dd { margin: 0; color: var(--color-accent-secondary-bright); word-break: break-word; }

.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
button.act {
  flex: 1 1 auto; min-width: 84px; min-height: 46px;
  font-family: var(--font-body); font-size: 13px; letter-spacing: 1px; text-transform: uppercase;
  background: var(--color-bg-input); color: var(--color-accent-primary);
  border: 1px solid var(--color-border-bright); border-radius: 2px;
  cursor: pointer; transition: background 0.12s, color 0.12s;
}
button.act:active { background: var(--color-accent-primary); color: var(--color-bg); }
button.act.danger { border-color: var(--color-danger); color: var(--color-danger); }
button.act.danger:active { background: var(--color-danger); color: var(--color-bg); }
button.act:disabled { opacity: 0.4; cursor: default; }

.output {
  margin-top: 12px; padding: 10px; border-radius: 2px;
  background: var(--color-bg-sunken); border: 1px solid var(--color-border-hairline);
  font-size: 12px; white-space: pre-wrap; word-break: break-word;
  color: var(--color-accent-secondary); max-height: 320px; overflow: auto;
}
.output.err { color: var(--color-danger); }
.output:empty { display: none; }

.wf-section { margin-top: 14px; border-top: 1px solid var(--color-border-hairline); padding-top: 10px; }
.wf-head { font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--color-fg-muted); margin-bottom: 8px; }
.wf-row { background: var(--color-bg-sunken); border: 1px solid var(--color-border-hairline); border-radius: 2px; padding: 10px; margin-bottom: 8px; }
.wf-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.wf-name { font-size: 14px; color: var(--color-accent-secondary-bright); }
.wf-state { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; padding: 2px 7px; border: 1px solid currentColor; border-radius: 2px; }
.wf-state.running { color: var(--color-warning); }
.wf-state.idle { color: var(--color-fg-muted); }
.wf-sub { font-size: 11px; color: var(--color-fg-muted); margin: 4px 0 8px; word-break: break-word; }
.wf-msg { margin: 0 0 10px; border-left: 2px solid var(--color-border-bright); padding-left: 10px; }
.wf-msg-label { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--color-fg-muted); margin-bottom: 4px; }
.wf-msg-body {
  font-size: 12.5px; line-height: 1.55; color: var(--color-accent-primary);
  white-space: pre-wrap; word-break: break-word;
  /* full response — scroll WITHIN a compact block so the card stays tidy on
     mobile; the whole message is there, just scroll it. */
  max-height: 300px; overflow: auto; -webkit-overflow-scrolling: touch;
  background: var(--color-bg-sunken); border-radius: 2px; padding: 10px;
  border: 1px solid var(--color-border-hairline);
}
.wf-msg-none { font-size: 11px; color: var(--color-fg-muted); font-style: italic; margin: 0 0 10px; }
/* 2026-07-18 — phone fix: action rows must WRAP, never push off-screen
   (Mailbox/Activity/Plan/Board and Compact/Fold/Handoff/Chat/Transcript both
   exceed one phone row). */
.wf-acts { display: flex; flex-wrap: wrap; gap: 8px; }
.wf-acts2 { margin-top: 8px; }
.wf-acts button.act, .wf-acts .act { min-height: 40px; }
.act-link {
  display: flex; align-items: center; justify-content: center;
  flex: 1 1 auto; min-width: 84px; min-height: 40px;
  font-family: var(--font-body); font-size: 13px; letter-spacing: 1px; text-transform: uppercase;
  text-decoration: none; color: var(--color-accent-secondary);
  background: var(--color-bg-input); border: 1px solid var(--color-accent-secondary-a30, var(--color-border-bright)); border-radius: 2px;
}
.act-link:active { background: var(--color-accent-secondary); color: var(--color-bg); }

/* R1 — context meter */
.ctx-meter { display: flex; align-items: center; gap: 8px; margin: 6px 0 8px; }
.ctx-bar { flex: 1; height: 6px; background: var(--color-bg-sunken); border: 1px solid var(--color-border-hairline); border-radius: 2px; overflow: hidden; }
.ctx-fill { height: 100%; background: var(--color-accent-primary-dim); }
.ctx-meter.zone-amber .ctx-fill { background: var(--color-warning); }
.ctx-meter.zone-red .ctx-fill { background: var(--color-danger); }
.ctx-label { font-size: 10px; letter-spacing: 1px; color: var(--color-fg-muted); text-transform: uppercase; white-space: nowrap; }
.ctx-meter.zone-amber .ctx-label { color: var(--color-warning); }
.ctx-meter.zone-red .ctx-label { color: var(--color-danger); }

/* R1 — NEEDS YOU strip (parked question / review gate) */
.needs { border: 1px solid var(--color-warning); border-left-width: 3px; border-radius: 2px; background: rgba(255,191,0,0.05); padding: 10px; margin: 0 0 10px; }
.needs.gate { border-color: var(--color-accent-secondary); background: rgba(92,224,214,0.05); }
.needs-label { font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: var(--color-warning); margin-bottom: 6px; }
.needs.gate .needs-label { color: var(--color-accent-secondary); }
.needs-text { font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; margin-bottom: 8px; }
.needs-args { font-size: 11px; color: var(--color-fg-muted); white-space: pre-wrap; word-break: break-all; background: var(--color-bg-sunken); border: 1px solid var(--color-border-hairline); border-radius: 2px; padding: 6px 8px; margin-bottom: 8px; max-height: 120px; overflow: auto; }
.needs-desk { font-size: 11px; color: var(--color-fg-muted); font-style: italic; }
.needs-input { flex: 3 1 auto; min-height: 44px; background: var(--color-bg-input); color: var(--color-fg); border: 1px solid var(--color-border-bright); border-radius: 2px; font-family: var(--font-body); font-size: 14px; padding: 8px 10px; }

/* R3 — cluster grouping */
.cluster-section { border-top: 1px solid var(--color-border-bright); }
.cluster-head { color: var(--color-accent-secondary); font-size: 12px; }
.cluster-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
.cluster-chip { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; padding: 3px 8px; border: 1px solid var(--color-border-hairline); border-radius: 2px; color: var(--color-fg-muted); }
.cluster-chip.on { color: var(--color-accent-primary); border-color: var(--color-border-bright); }
.cluster-chip.warn { color: var(--color-warning); border-color: var(--color-warning); }
.cluster-reader { margin: 8px 0; }
.cluster-reader:empty { display: none; }
.mb-member { font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: var(--color-accent-secondary); margin: 8px 0 4px; }
.mb-msg { font-size: 12px; color: var(--color-fg-muted); border-left: 2px solid var(--color-border-hairline); padding: 4px 8px; margin-bottom: 4px; white-space: pre-wrap; word-break: break-word; }
.plan-head { font-size: 11.5px; color: var(--color-fg-muted); white-space: pre-wrap; word-break: break-word; border: 1px dashed var(--color-border-hairline); border-radius: 2px; padding: 8px; margin: 0 0 10px; max-height: 140px; overflow: auto; }
.board-task { font-size: 12px; margin-bottom: 5px; word-break: break-word; }
.board-status { font-size: 9px; letter-spacing: 1px; text-transform: uppercase; border: 1px solid currentColor; border-radius: 2px; padding: 1px 5px; color: var(--color-fg-muted); }
.board-task.st-in_progress .board-status { color: var(--color-warning); }
.board-task.st-done .board-status { color: var(--color-success); }
.board-task.st-blocked .board-status { color: var(--color-danger); }
.board-assignee { color: var(--color-accent-secondary); font-size: 11px; }
.member-badge { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--color-accent-secondary); margin: 4px 0 6px; }

/* R5 — merged activity timeline */
.act-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; font-size: 12px; padding: 5px 0; border-bottom: 1px solid rgba(74,240,102,0.06); }
.act-member { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--color-accent-secondary); border: 1px solid var(--color-border-hairline); border-radius: 2px; padding: 1px 6px; white-space: nowrap; }
.act-when { font-size: 10px; color: var(--color-fg-muted); white-space: nowrap; }
.act-text { flex: 1 1 100%; color: var(--color-fg-muted); word-break: break-word; white-space: pre-wrap; }
.act-row.k-peer-sent .act-text, .act-row.k-peer-received .act-text { color: var(--color-accent-primary); }
.act-row.k-nudged .act-text { color: var(--color-warning); }

/* 2026-07-18 — per-member mail breakdown (tap the pending chip) */
.mail-glance { margin: 0 0 10px; }
.mail-glance:empty { display: none; }
.mail-glance-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; border: 1px solid var(--color-border-hairline); border-radius: 2px; padding: 9px 10px; margin-bottom: 6px; }
.mail-glance-row.none { opacity: 0.55; }
.mail-glance-name { font-size: 13px; color: var(--color-accent-secondary-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mail-glance-badges { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.mail-glance-role { font-size: 9px; letter-spacing: 1px; border: 1px solid var(--color-border-bright); border-radius: 2px; padding: 2px 6px; color: var(--color-accent-secondary); }
.mail-glance-count { font-size: 10px; letter-spacing: 1px; color: var(--color-fg-muted); }
.mail-glance-count.has { color: var(--color-warning); }
.mail-glance-nudge { flex: 0 0 auto; min-width: 64px; min-height: 38px; font-size: 10px; }
.mail-glance-all { width: 100%; min-height: 44px; margin-top: 2px; }

/* R4 — cluster actions */
button.cluster-chip.tappable { cursor: pointer; background: var(--color-bg-input); font-family: var(--font-body); min-height: 32px; }
button.cluster-chip.tappable:active { background: var(--color-accent-primary); color: var(--color-bg); }
.bc-panel { margin: 8px 0; }
.bc-panel:empty { display: none; }
.bc-member { display: block; font-size: 12.5px; color: var(--color-accent-secondary-bright); padding: 6px 0; }
.bc-member input { width: 18px; height: 18px; accent-color: var(--color-accent-primary); margin-right: 6px; }
.bc-text { width: 100%; box-sizing: border-box; min-height: 64px; background: var(--color-bg-input); color: var(--color-fg); border: 1px solid var(--color-border-bright); border-radius: 2px; font-family: var(--font-body); font-size: 14px; padding: 10px; margin: 6px 0; }
.board-task { display: flex; align-items: center; gap: 8px; }
.board-task > span:first-child { flex: 1; }
.board-adv { flex: 0 0 auto; min-width: 70px; min-height: 34px; font-size: 10px; }

/* A2 — auth-required banner + remote re-auth flow */
.auth-banner { border: 1px solid var(--color-danger); border-left-width: 3px; border-radius: 2px; background: rgba(255,0,64,0.06); padding: 10px; margin: 10px 0; }
.auth-head { font-size: 12px; letter-spacing: 1px; text-transform: uppercase; color: var(--color-danger); margin-bottom: 8px; word-break: break-word; }
.auth-link { margin: 8px 0; }
.auth-hint { font-size: 11.5px; color: var(--color-fg-muted); line-height: 1.5; margin: 8px 0; }

/* R1 — queued operator messages */
.queue-row { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; padding: 6px 8px; border: 1px dashed var(--color-border-hairline); border-radius: 2px; }
.queue-text { flex: 1; font-size: 12px; color: var(--color-fg-muted); word-break: break-word; }
.queue-x { flex: 0 0 auto; min-width: 44px; min-height: 36px; }

/* R6 — deep-link landing flash */
.deep-linked { animation: dlflash 1.2s ease-in-out 2; }
@keyframes dlflash { 50% { box-shadow: 0 0 0 2px var(--color-accent-secondary), 0 0 18px var(--color-accent-secondary); } }

.status-line { color: var(--color-fg-muted); font-size: 12px; text-align: center; padding: 8px 0; letter-spacing: 1px; }
.empty { text-align: center; color: var(--color-fg-muted); padding: 40px 0; }
.spin { animation: blink 1s steps(2) infinite; }
@keyframes blink { 50% { opacity: 0.3; } }
`;
}

export function consoleJs(): string {
  // Vanilla JS — no framework. Polls the control API, renders instance cards,
  // wires lifecycle buttons (POST), shows command output. Lifecycle commands
  // are the fixed allowlist; the hub signs + routes them.
  return `
const LIFECYCLE = [
  { cmd: 'arco.status',  label: 'Status' },
  { cmd: 'arco.start',   label: 'Start' },
  { cmd: 'arco.restart', label: 'Restart' },
  { cmd: 'arco.stop',    label: 'Stop', danger: true },
  { cmd: 'arco.logs.tail', label: 'Logs' },
];
const $ = (sel) => document.querySelector(sel);
function ago(ms) {
  if (!ms) return 'never';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  return Math.floor(s/3600) + 'h ago';
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

async function send(id, cmd, btn, outEl) {
  const buttons = btn.parentElement.querySelectorAll('button');
  buttons.forEach(b => b.disabled = true);
  outEl.classList.remove('err');
  outEl.textContent = '> ' + cmd + ' …';
  try {
    const res = await fetch('/api/instances/' + encodeURIComponent(id) + '/lifecycle', {
      method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ cmd }),
    });
    const body = await res.json();
    if (!body.ok) {
      outEl.classList.add('err');
      outEl.textContent = '✗ ' + (body.error || (body.result && body.result.rejectedReason) || 'failed');
    } else {
      const r = body.result || {};
      const text = (r.stdout || '').trim() || (r.stderr || '').trim() || ('exit ' + r.exitCode);
      outEl.classList.toggle('err', r.exitCode !== 0);
      outEl.textContent = text;
    }
  } catch (e) {
    outEl.classList.add('err');
    outEl.textContent = '✗ ' + e.message;
  } finally {
    buttons.forEach(b => b.disabled = false);
  }
}

// A2 — the remote re-auth flow. One tap starts the service's PKCE bootstrap;
// the authorize link opens claude.ai in the phone browser; after approving,
// the redirect to localhost:53692 FAILS on the phone (wrong host) — the
// operator copies that failed URL from the address bar into the paste box.
function authBanner(id, alert) {
  const b = document.createElement('div');
  b.className = 'auth-banner';
  const head = document.createElement('div');
  head.className = 'auth-head';
  head.textContent = '⚠ AUTH REQUIRED — ' + alert.provider + (alert.detail ? ' · ' + alert.detail : '');
  b.appendChild(head);
  const out = document.createElement('div');
  out.className = 'output';
  const flow = document.createElement('div');
  const start = document.createElement('button');
  start.className = 'act danger';
  start.textContent = 'Re-auth ' + alert.provider;
  start.onclick = async () => {
    start.disabled = true;
    out.textContent = '> starting OAuth bootstrap …';
    try {
      const res = await fetch('/api/instances/' + encodeURIComponent(id) + '/instance-action', {
        method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify({ action: { type: 'start_reauth', provider: alert.provider } }),
      });
      const r = await res.json();
      if (!r.ok || !r.authorizationUrl) {
        out.classList.add('err');
        out.textContent = '✗ ' + (r.error || 'could not start the flow');
        return;
      }
      out.textContent = '';
      flow.innerHTML = '';
      const link = document.createElement('a');
      link.className = 'act act-link auth-link';
      link.textContent = '1 · Open the authorize page';
      link.href = r.authorizationUrl;
      link.target = '_blank'; link.rel = 'noopener';
      const hint = document.createElement('div');
      hint.className = 'auth-hint';
      hint.textContent = '2 · Approve there. The redirect to localhost WILL fail on this phone — copy that failed URL from the address bar and paste it here:';
      const pasteRow = document.createElement('div');
      pasteRow.className = 'wf-acts';
      const paste = document.createElement('input');
      paste.className = 'needs-input';
      paste.placeholder = 'http://localhost:53692/callback?code=…';
      const done = document.createElement('button');
      done.className = 'act';
      done.textContent = 'Complete';
      done.onclick = async () => {
        const url = paste.value.trim();
        if (!url) return;
        done.disabled = true;
        out.classList.remove('err');
        out.textContent = '> completing …';
        try {
          const res2 = await fetch('/api/instances/' + encodeURIComponent(id) + '/instance-action', {
            method: 'POST', headers: {'content-type':'application/json'},
            body: JSON.stringify({ action: { type: 'complete_reauth', provider: alert.provider, url } }),
          });
          const r2 = await res2.json();
          if (r2.ok) { out.textContent = '✓ re-authenticated — the banner clears on the next heartbeat'; }
          else { out.classList.add('err'); out.textContent = '✗ ' + (r2.error || 'completion failed'); }
        } catch (e) {
          out.classList.add('err'); out.textContent = '✗ ' + e.message;
        } finally { done.disabled = false; }
      };
      pasteRow.appendChild(paste); pasteRow.appendChild(done);
      flow.appendChild(link); flow.appendChild(hint); flow.appendChild(pasteRow);
    } catch (e) {
      out.classList.add('err');
      out.textContent = '✗ ' + e.message;
    } finally { start.disabled = false; }
  };
  const acts = document.createElement('div');
  acts.className = 'wf-acts';
  acts.appendChild(start);
  b.appendChild(acts);
  b.appendChild(flow);
  b.appendChild(out);
  return b;
}

function card(entry) {
  const i = entry.instance;
  const el = document.createElement('div');
  el.className = 'card ' + entry.state;
  const head = document.createElement('div');
  head.className = 'card-head';
  head.innerHTML = '<span class="name">' + esc(i.name) + '</span>' +
    '<span class="badge ' + entry.state + '">' + entry.state + '</span>';
  el.appendChild(head);

  // A2 — auth alerts render ABOVE everything else on the card.
  for (const alert of ((entry.rollup && entry.rollup.authAlerts) || [])) {
    el.appendChild(authBanner(i.instanceId, alert));
  }

  const ts = i.tailscale ? (i.tailscale.magicDns || i.tailscale.ip || '') : '';
  const meta = document.createElement('dl');
  meta.className = 'meta';
  meta.innerHTML =
    '<dt>host</dt><dd>' + esc(i.hostname) + (ts ? ' · ' + esc(ts) : '') + '</dd>' +
    '<dt>platform</dt><dd>' + esc(i.platform) + ' / ' + esc(i.serviceMode) + '</dd>' +
    '<dt>version</dt><dd>' + esc(i.version) + ' (' + esc(i.gitRevision) + ')</dd>' +
    '<dt>seen</dt><dd>' + ago(entry.lastHeartbeatAt) +
      (entry.rollup ? ' · ' + esc(entry.rollup.health) + ' · ' + (entry.rollup.activeWorkflows||0) + ' active' : '') + '</dd>';
  el.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const out = document.createElement('div');
  out.className = 'output';
  for (const l of LIFECYCLE) {
    const b = document.createElement('button');
    b.className = 'act' + (l.danger ? ' danger' : '');
    b.textContent = l.label;
    b.disabled = entry.state === 'offline';
    b.onclick = () => send(i.instanceId, l.cmd, b, out);
    actions.appendChild(b);
  }
  el.appendChild(actions);
  el.appendChild(out);

  // ── workflow layer (only when the live Arco service is reporting) ──
  // R3 — cluster members render grouped under their cluster card; standalone
  // workflows keep the flat Workflows section.
  const wfs = entry.workflows || [];
  const clusters = entry.clusters || [];
  const byId = {};
  for (const w of wfs) byId[w.workflowId] = w;
  const clustered = {};
  for (const c of clusters) for (const m of c.memberIds) clustered[m] = true;

  for (const c of clusters) el.appendChild(clusterCard(i.instanceId, c, byId));

  const solo = wfs.filter(w => !clustered[w.workflowId]);
  if (solo.length) {
    const sec = document.createElement('div');
    sec.className = 'wf-section';
    const h = document.createElement('div');
    h.className = 'wf-head';
    h.textContent = 'Workflows · ' + solo.length;
    sec.appendChild(h);
    for (const w of solo) sec.appendChild(wfRow(i.instanceId, w));
    el.appendChild(sec);
  }
  return el;
}

// R4 — cluster-scoped action POST, mirroring wfAction.
async function clusterAction(id, clusterId, action, btn, outEl) {
  if (btn) btn.disabled = true;
  outEl.classList.remove('err');
  outEl.textContent = '> ' + action.type + ' …';
  try {
    const res = await fetch('/api/instances/' + encodeURIComponent(id) + '/clusters/' + encodeURIComponent(clusterId) + '/action', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ action }),
    });
    const b = await res.json();
    if (!b.ok) { outEl.classList.add('err'); outEl.textContent = '✗ ' + (b.error || 'failed'); }
    else { outEl.textContent = '✓ ' + (b.applied || action.type) + (b.detail ? ' · ' + b.detail : ''); }
  } catch (e) {
    outEl.classList.add('err'); outEl.textContent = '✗ ' + e.message;
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(() => refresh(), 700);
  }
}

const EFFICIENCY_CYCLE = { thorough: 'balanced', balanced: 'lean', lean: 'thorough' };

// R3/R4 — one cluster's grouped view: tappable knob chips, broadcast panel,
// plan/mailbox/board readers, then the member workflow rows in the
// operator-arranged members[] order.
function clusterCard(id, c, byId) {
  const sec = document.createElement('div');
  sec.className = 'wf-section cluster-section';
  const h = document.createElement('div');
  h.className = 'wf-head cluster-head';
  h.textContent = '⬡ Cluster · ' + (c.name || c.clusterId.slice(0, 8)) + ' · ' + c.memberIds.length + ' members';
  sec.appendChild(h);

  const cOut = document.createElement('div');
  cOut.className = 'output';

  const chips = document.createElement('div');
  chips.className = 'cluster-chips';
  const pending = Object.values(c.mailboxDepth || {}).reduce((a, b) => a + b, 0);
  const mkChip = (text, cls, onTap, title) => {
    const s = document.createElement(onTap ? 'button' : 'span');
    s.className = 'cluster-chip ' + (cls || '') + (onTap ? ' tappable' : '');
    s.textContent = text;
    if (title) s.title = title;
    if (onTap) s.onclick = onTap;
    return s;
  };
  // R4 — efficiency chip cycles thorough → balanced → lean on tap.
  chips.appendChild(mkChip(c.efficiencyLevel, '', () => {
    const next = EFFICIENCY_CYCLE[c.efficiencyLevel] || 'thorough';
    if (confirm('Set efficiency to ' + next + '? Takes effect next turn.')) {
      clusterAction(id, c.clusterId, { type: 'set_efficiency', level: next }, null, cOut);
    }
  }, 'Tap to cycle efficiency level'));
  chips.appendChild(mkChip('board: ' + c.taskBoardMode, ''));
  chips.appendChild(mkChip(c.autoTurnOnMailbox ? 'auto-pickup ON' : 'auto-pickup off', c.autoTurnOnMailbox ? 'on' : '', () => {
    if (confirm((c.autoTurnOnMailbox ? 'Disable' : 'Enable') + ' auto-pickup (auto-turn on mailbox delivery)?')) {
      clusterAction(id, c.clusterId, { type: 'toggle_auto_turn', enabled: !c.autoTurnOnMailbox }, null, cOut);
    }
  }, 'Tap to toggle'));
  chips.appendChild(mkChip(c.idleNudgerEnabled ? 'nudges ON' : 'nudges off', c.idleNudgerEnabled ? 'on' : '', () => {
    if (confirm((c.idleNudgerEnabled ? 'Disable' : 'Enable') + ' the idle nudger (operator-facing toasts only)?')) {
      clusterAction(id, c.clusterId, { type: 'toggle_idle_nudger', enabled: !c.idleNudgerEnabled }, null, cOut);
    }
  }, 'Tap to toggle'));
  // 2026-07-18 — the pending chip taps open an at-a-glance per-member mail
  // breakdown (straight from mailboxDepth — no fetch): every member listed,
  // mail counts badged, zero-mail members dimmed.
  const mailPanel = document.createElement('div');
  mailPanel.className = 'mail-glance';
  chips.appendChild(mkChip('✉ ' + pending + ' pending', pending > 0 ? 'warn' : '', () => {
    if (mailPanel.childNodes.length) { mailPanel.innerHTML = ''; return; }
    const withMail = c.memberIds.filter(m => ((c.mailboxDepth || {})[m] || 0) > 0);
    for (const wfid of c.memberIds) {
      const w = byId[wfid];
      const n = (c.mailboxDepth || {})[wfid] || 0;
      const row = document.createElement('div');
      row.className = 'mail-glance-row' + (n ? '' : ' none');
      const name = document.createElement('span');
      name.className = 'mail-glance-name';
      name.textContent = '● ' + (w ? w.title : wfid.slice(0, 8));
      const cl = (w && w.cluster) || {};
      const badges = document.createElement('span');
      badges.className = 'mail-glance-badges';
      if (cl.role) {
        const r = document.createElement('span');
        r.className = 'mail-glance-role';
        r.textContent = cl.role.toUpperCase().slice(0, 14);
        badges.appendChild(r);
      }
      const count = document.createElement('span');
      count.className = 'mail-glance-count' + (n ? ' has' : '');
      count.textContent = n === 1 ? '1 MAIL' : n + ' MAIL';
      badges.appendChild(count);
      // 2026-07-18 — act from the glance: fire the mailbox nudge right here
      // instead of hunting down the member's own row.
      if (n) {
        const nd = document.createElement('button');
        nd.className = 'act mail-glance-nudge';
        nd.textContent = 'Nudge';
        nd.onclick = () => clusterAction(id, c.clusterId, { type: 'nudge_member', memberId: wfid }, nd, cOut);
        badges.appendChild(nd);
      }
      row.appendChild(name); row.appendChild(badges);
      mailPanel.appendChild(row);
    }
    if (withMail.length > 1) {
      const all = document.createElement('button');
      all.className = 'act mail-glance-all';
      all.textContent = 'Nudge all with mail (' + withMail.length + ')';
      all.onclick = async () => {
        all.disabled = true;
        cOut.classList.remove('err');
        let ok = 0;
        for (const wfid of withMail) {
          cOut.textContent = '> nudging ' + ((byId[wfid] && byId[wfid].title) || wfid.slice(0, 8)) + ' …';
          try {
            const res = await fetch('/api/instances/' + encodeURIComponent(id) + '/clusters/' + encodeURIComponent(c.clusterId) + '/action', {
              method: 'POST', headers: {'content-type':'application/json'},
              body: JSON.stringify({ action: { type: 'nudge_member', memberId: wfid } }),
            });
            const b = await res.json();
            if (b.ok) ok++;
          } catch (e) { /* keep going — summary line below reports the shortfall */ }
        }
        cOut.classList.toggle('err', ok < withMail.length);
        cOut.textContent = (ok === withMail.length ? '✓ nudged ' : '✗ nudged only ') + ok + '/' + withMail.length + ' member(s)';
        all.disabled = false;
        setTimeout(() => refresh(), 700);
      };
      mailPanel.appendChild(all);
    }
  }, 'Tap for the per-member mail breakdown'));
  sec.appendChild(chips);
  sec.appendChild(mailPanel);

  // R4 — broadcast panel (member-subset checkboxes) + STOP ALL.
  const actRow = document.createElement('div');
  actRow.className = 'wf-acts';
  const bcPanel = document.createElement('div');
  bcPanel.className = 'bc-panel';
  const bc = document.createElement('button');
  bc.className = 'act'; bc.textContent = 'Broadcast';
  bc.onclick = () => {
    if (bcPanel.childNodes.length) { bcPanel.innerHTML = ''; return; }
    const boxes = [];
    for (const wfid of c.memberIds) {
      const w = byId[wfid];
      const label = document.createElement('label');
      label.className = 'bc-member';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = true; cb.value = wfid;
      boxes.push(cb);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + (w ? w.title : wfid.slice(0, 8))));
      bcPanel.appendChild(label);
    }
    const ta = document.createElement('textarea');
    ta.className = 'bc-text'; ta.placeholder = 'message to the checked members…';
    bcPanel.appendChild(ta);
    const send = document.createElement('button');
    send.className = 'act'; send.textContent = 'Send broadcast';
    send.onclick = () => {
      const body = ta.value.trim();
      if (!body) return;
      const picked = boxes.filter(b => b.checked).map(b => b.value);
      if (!picked.length) return;
      const all = picked.length === c.memberIds.length;
      clusterAction(id, c.clusterId, { type: 'broadcast', body, ...(all ? {} : { recipientIds: picked }) }, send, cOut);
      bcPanel.innerHTML = '';
    };
    bcPanel.appendChild(send);
  };
  actRow.appendChild(bc);
  const stopAll = document.createElement('button');
  stopAll.className = 'act danger'; stopAll.textContent = 'Stop all';
  stopAll.onclick = () => {
    if (confirm('Stop EVERY busy member in this cluster?') && confirm('Really stop all in-flight turns?')) {
      clusterAction(id, c.clusterId, { type: 'stop_all' }, stopAll, cOut);
    }
  };
  actRow.appendChild(stopAll);
  sec.appendChild(actRow);
  sec.appendChild(bcPanel);
  sec.appendChild(cOut);

  // Reader row: mailbox / plan / board fetched on demand into a shared panel.
  const readerOut = document.createElement('div');
  readerOut.className = 'cluster-reader';
  const readers = document.createElement('div');
  readers.className = 'wf-acts';
  const mkReader = (label, kind, render) => {
    const b = document.createElement('button');
    b.className = 'act';
    b.textContent = label;
    b.onclick = async () => {
      if (readerOut.getAttribute('data-open') === kind) {
        readerOut.innerHTML = ''; readerOut.removeAttribute('data-open'); return;
      }
      readerOut.setAttribute('data-open', kind);
      readerOut.innerHTML = '<div class="wf-msg-none">loading ' + kind + ' …</div>';
      try {
        const res = await fetch('/api/instances/' + encodeURIComponent(id) + '/clusters/' + encodeURIComponent(c.clusterId) + '/read?kind=' + kind);
        const data = await res.json();
        readerOut.innerHTML = '';
        if (!data.ok) { readerOut.innerHTML = '<div class="wf-msg-none">✗ ' + esc(data.error || 'failed') + '</div>'; return; }
        render(data, readerOut);
      } catch (e) {
        readerOut.innerHTML = '<div class="wf-msg-none">✗ ' + esc(e.message) + '</div>';
      }
    };
    return b;
  };
  readers.appendChild(mkReader('Mailbox', 'mailbox', (data, out) => {
    let any = false;
    for (const wfid of Object.keys(data.mailbox || {})) {
      const msgs = data.mailbox[wfid];
      if (!msgs.length) continue;
      any = true;
      const w = byId[wfid];
      const head = document.createElement('div');
      head.className = 'mb-member';
      head.textContent = '→ ' + (w ? w.title : wfid.slice(0, 8)) + ' · ' + msgs.length + ' pending';
      out.appendChild(head);
      for (const m of msgs) {
        const row = document.createElement('div');
        row.className = 'mb-msg';
        row.textContent = m.fromName + ': ' + m.preview;
        out.appendChild(row);
      }
    }
    if (!any) out.innerHTML = '<div class="wf-msg-none">no pending peer messages</div>';
  }));
  // R5 — the merged group timeline (member-badged, kind-filterable by eye).
  readers.appendChild(mkReader('Activity', 'activity', (data, out) => {
    const rows = data.activity || [];
    if (!rows.length) { out.innerHTML = '<div class="wf-msg-none">no activity yet</div>'; return; }
    for (const r of rows.slice().reverse()) {
      const w = byId[r.memberId];
      const row = document.createElement('div');
      row.className = 'act-row k-' + r.kind;
      const badge = document.createElement('span');
      badge.className = 'act-member';
      badge.textContent = (w ? w.title : r.memberId.slice(0, 8));
      const when = document.createElement('span');
      when.className = 'act-when';
      when.textContent = ago(r.ts);
      const txt = document.createElement('span');
      txt.className = 'act-text';
      txt.textContent = r.text;
      row.appendChild(badge); row.appendChild(when); row.appendChild(txt);
      out.appendChild(row);
    }
  }));
  readers.appendChild(mkReader('Plan', 'plan', (data, out) => {
    const body = document.createElement('div');
    body.className = 'wf-msg-body';
    body.textContent = (data.plan && data.plan.body) || '(empty plan)';
    out.appendChild(body);
  }));
  readers.appendChild(mkReader('Board', 'board', (data, out) => {
    const tasks = (data.board && data.board.tasks) || [];
    if (!tasks.length) { out.innerHTML = '<div class="wf-msg-none">no tasks on the board</div>'; return; }
    // R4 §9.4 — tap-to-advance along the canonical order (incl. done).
    const NEXT = { triage: 'todo', todo: 'ready', ready: 'in_progress', in_progress: 'review', review: 'done', blocked: 'ready' };
    for (const t of tasks) {
      const row = document.createElement('div');
      row.className = 'board-task st-' + t.status;
      const label = document.createElement('span');
      label.innerHTML = '<span class="board-status">' + esc(t.status) + '</span> ' + esc(t.title) +
        (t.assignee ? ' <span class="board-assignee">@' + esc(t.assignee) + '</span>' : '');
      row.appendChild(label);
      const next = NEXT[t.status];
      if (next) {
        const adv = document.createElement('button');
        adv.className = 'act board-adv';
        adv.textContent = '▸ ' + next;
        adv.onclick = () => {
          if (confirm('Move "' + t.title + '" to ' + next + '?')) {
            clusterAction(id, c.clusterId, { type: 'board_task_update', taskId: t.id, status: next }, adv, cOut);
          }
        };
        row.appendChild(adv);
      }
      out.appendChild(row);
    }
  }));
  sec.appendChild(readers);
  sec.appendChild(readerOut);

  if (c.planHead) {
    const ph = document.createElement('div');
    ph.className = 'plan-head';
    ph.textContent = c.planHead;
    sec.appendChild(ph);
  }

  // Member rows in members[] order (operator-arranged), each the full wfRow
  // plus R4 member-level actions: NUDGE (canned mailbox prompt) + PeerMsg.
  for (const wfid of c.memberIds) {
    const w = byId[wfid];
    if (w) {
      const row = wfRow(id, w);
      const badge = document.createElement('div');
      badge.className = 'member-badge';
      const cl = w.cluster || {};
      const depth = (c.mailboxDepth || {})[wfid] || 0;
      badge.textContent = (cl.role ? cl.role : 'member') + (cl.tier ? ' · ' + cl.tier : '') +
        (cl.focus ? ' · ' + cl.focus : '') + (depth ? ' · ✉ ' + depth : '');
      row.insertBefore(badge, row.firstChild.nextSibling);

      const mActs = document.createElement('div');
      mActs.className = 'wf-acts wf-acts2';
      const mOut = document.createElement('div');
      mOut.className = 'output';
      const nudge = document.createElement('button');
      nudge.className = 'act';
      nudge.textContent = depth ? 'Nudge (✉ ' + depth + ')' : 'Nudge';
      nudge.title = 'Send this member a canned "read your mailbox" prompt (one visible operator turn)';
      nudge.onclick = () => {
        if (confirm('Nudge ' + w.title + ' to read its mailbox now?')) {
          clusterAction(id, c.clusterId, { type: 'nudge_member', memberId: wfid }, nudge, mOut);
        }
      };
      mActs.appendChild(nudge);
      const peer = document.createElement('button');
      peer.className = 'act';
      peer.textContent = 'Peer msg';
      peer.title = 'Drop a note into another member\\'s mailbox AS this member';
      peer.onclick = () => {
        const others = c.memberIds.filter(m => m !== wfid);
        const names = others.map((m, ix) => (ix + 1) + '=' + ((byId[m] && byId[m].title) || m.slice(0, 8))).join('  ');
        const pick = prompt('Send peer message FROM ' + w.title + ' TO which member?\\n' + names + '\\n(enter number)');
        const ix = parseInt(pick || '', 10) - 1;
        if (!(ix >= 0 && ix < others.length)) return;
        const body = prompt('Message to ' + ((byId[others[ix]] && byId[others[ix]].title) || others[ix].slice(0, 8)) + ':');
        if (body && body.trim()) {
          clusterAction(id, c.clusterId, { type: 'peer_send', fromId: wfid, toId: others[ix], body: body.trim() }, peer, mOut);
        }
      };
      mActs.appendChild(peer);
      row.appendChild(mActs);
      row.appendChild(mOut);
      sec.appendChild(row);
    }
  }
  return sec;
}

async function wfAction(id, wfid, type, body, btn, outEl, extra) {
  const buttons = btn.parentElement.querySelectorAll('button');
  buttons.forEach(b => b.disabled = true);
  outEl.classList.remove('err');
  outEl.textContent = '> ' + type + ' …';
  try {
    const action = Object.assign({ type, workflowId: wfid, body }, extra || {});
    const res = await fetch('/api/instances/' + encodeURIComponent(id) + '/workflow-action', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ action }),
    });
    const b = await res.json();
    if (!b.ok) { outEl.classList.add('err'); outEl.textContent = '✗ ' + (b.error || 'failed'); }
    else { outEl.textContent = '✓ ' + (b.applied || type) + ' accepted'; }
  } catch (e) {
    outEl.classList.add('err'); outEl.textContent = '✗ ' + e.message;
  } finally {
    buttons.forEach(b => b.disabled = false);
    setTimeout(() => refresh(), 600);
  }
}

function wfRow(id, w) {
  const row = document.createElement('div');
  row.className = 'wf-row';
  row.setAttribute('data-wfrow', w.workflowId); // R6 — deep-link anchor
  const top = document.createElement('div');
  top.className = 'wf-top';
  top.innerHTML = '<span class="wf-name">' + esc(w.title) + '</span>' +
    '<span class="wf-state ' + w.state + '">' + w.state + '</span>';
  row.appendChild(top);
  const sub = document.createElement('div');
  sub.className = 'wf-sub';
  const when = w.lastActivityAt ? ' · ' + ago(w.lastActivityAt) : '';
  const dur = w.lastTurnDurationMs ? ' · last turn ' + Math.round(w.lastTurnDurationMs / 1000) + 's' : '';
  const eff = w.effort ? ' · ' + w.effort : '';
  sub.textContent = w.provider + ' · ' + w.model + eff + when + dur;
  row.appendChild(sub);

  // R1 — context meter. 2026-07-18: label matches the desktop CTX chip
  // ("CTX: 109k / 1000k 11%") when the raw numbers are reported.
  if (typeof w.contextPct === 'number') {
    const meter = document.createElement('div');
    meter.className = 'ctx-meter zone-' + (w.contextZone || 'green');
    const pctText = Math.round(w.contextPct * 100) + '%';
    const kf = (n) => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n));
    const label = (typeof w.contextTokens === 'number' && typeof w.contextWindow === 'number')
      ? 'CTX: ' + kf(w.contextTokens) + ' / ' + kf(w.contextWindow) + ' ' + pctText
      : 'ctx ' + pctText;
    meter.innerHTML = '<div class="ctx-bar"><div class="ctx-fill" style="width:' + Math.min(100, Math.round(w.contextPct * 100)) + '%"></div></div>' +
      '<span class="ctx-label">' + label + '</span>';
    row.appendChild(meter);
  }

  const out = document.createElement('div');
  out.className = 'output';

  // R1 — NEEDS YOU strip: parked question / gates, above all secondary detail.
  if (w.pendingQuestion) {
    const q = document.createElement('div');
    q.className = 'needs';
    const label = document.createElement('div');
    label.className = 'needs-label';
    label.textContent = '⚑ question — the agent is waiting on you';
    const text = document.createElement('div');
    text.className = 'needs-text';
    text.textContent = w.pendingQuestion.text;
    const answerRow = document.createElement('div');
    answerRow.className = 'wf-acts';
    const input = document.createElement('input');
    input.className = 'needs-input';
    input.placeholder = 'answer…';
    const send = document.createElement('button');
    send.className = 'act'; send.textContent = 'Answer';
    send.onclick = () => {
      const v = input.value.trim();
      if (v) wfAction(id, w.workflowId, 'answer_question', v, send, out, { questionId: w.pendingQuestion.questionId });
    };
    answerRow.appendChild(input); answerRow.appendChild(send);
    q.appendChild(label); q.appendChild(text); q.appendChild(answerRow);
    row.appendChild(q);
  }
  for (const g of (w.pendingGates || [])) {
    const gd = document.createElement('div');
    gd.className = 'needs gate';
    const label = document.createElement('div');
    label.className = 'needs-label';
    label.textContent = '⛨ review gate — ' + g.toolName + ' (' + g.category + ')';
    const text = document.createElement('div');
    text.className = 'needs-text';
    text.textContent = g.reason;
    const args = document.createElement('div');
    args.className = 'needs-args';
    args.textContent = g.argsPreview;
    gd.appendChild(label); gd.appendChild(text); gd.appendChild(args);
    if (g.resolvable) {
      const acts = document.createElement('div');
      acts.className = 'wf-acts';
      const ok = document.createElement('button');
      ok.className = 'act'; ok.textContent = 'Approve';
      ok.onclick = () => {
        if (confirm('Approve this ' + g.toolName + ' call? It runs exactly as proposed.')) {
          wfAction(id, w.workflowId, 'gate_resolve', undefined, ok, out, { gateId: g.gateId, decision: 'approve' });
        }
      };
      const no = document.createElement('button');
      no.className = 'act danger'; no.textContent = 'Reject';
      no.onclick = () => wfAction(id, w.workflowId, 'gate_resolve', undefined, no, out, { gateId: g.gateId, decision: 'reject' });
      acts.appendChild(ok); acts.appendChild(no);
      gd.appendChild(acts);
    } else {
      const desk = document.createElement('div');
      desk.className = 'needs-desk';
      desk.textContent = 'resolve at desk — remote gate approval not armed for this workflow';
      gd.appendChild(desk);
    }
    row.appendChild(gd);
  }

  // R1 — queued operator messages waiting behind the current turn.
  for (const qm of (w.queued || [])) {
    const qr = document.createElement('div');
    qr.className = 'queue-row';
    const txt = document.createElement('span');
    txt.className = 'queue-text';
    txt.textContent = '⧗ queued: ' + qm.preview;
    qr.appendChild(txt);
    if (qm.id) {
      const x = document.createElement('button');
      x.className = 'act danger queue-x'; x.textContent = '✕';
      x.onclick = () => wfAction(id, w.workflowId, 'cancel_queued', undefined, x, out, { queuedId: qm.id });
      qr.appendChild(x);
    }
    row.appendChild(qr);
  }

  // Decision context — the FULL last assistant message (§13.5).
  if (w.lastMessageText) {
    const msg = document.createElement('div');
    msg.className = 'wf-msg';
    const label = document.createElement('div');
    label.className = 'wf-msg-label';
    label.textContent = (w.lastMessageRole || 'assistant') + ' · last message';
    const body = document.createElement('div');
    body.className = 'wf-msg-body';
    body.setAttribute('data-wfid', w.workflowId);
    body.textContent = w.lastMessageText;
    msg.appendChild(label);
    msg.appendChild(body);
    row.appendChild(msg);
  } else {
    const none = document.createElement('div');
    none.className = 'wf-msg-none';
    none.textContent = 'no conversation turns yet';
    row.appendChild(none);
  }

  const acts = document.createElement('div');
  acts.className = 'wf-acts';

  if (w.state === 'running') {
    const stop = document.createElement('button');
    stop.className = 'act danger'; stop.textContent = 'Stop';
    stop.onclick = () => wfAction(id, w.workflowId, 'stop', undefined, stop, out);
    acts.appendChild(stop);
  } else {
    const reply = document.createElement('button');
    reply.className = 'act'; reply.textContent = 'Reply';
    reply.onclick = () => {
      const body = prompt('Reply to ' + w.title + ':');
      if (body && body.trim()) wfAction(id, w.workflowId, 'reply', body.trim(), reply, out);
    };
    const cont = document.createElement('button');
    cont.className = 'act'; cont.textContent = 'Continue';
    cont.onclick = () => wfAction(id, w.workflowId, 'continue', undefined, cont, out);
    acts.appendChild(reply); acts.appendChild(cont);
  }
  row.appendChild(acts);

  // Secondary row: same-worker handoff (idle only — rotates the worker to free
  // context) + open the full conversation in a new tab.
  const acts2 = document.createElement('div');
  acts2.className = 'wf-acts wf-acts2';
  if (w.state !== 'running') {
    // R1 — COMPACT / FOLD (context relief without losing the tab). The service
    // computed canCompact/canFold from provider+transport; it re-validates on
    // dispatch regardless.
    if (w.canCompact) {
      const cp = document.createElement('button');
      cp.className = 'act'; cp.textContent = 'Compact';
      cp.onclick = () => {
        if (confirm('Compact "' + w.title + '"? Summarizes settled history in place to free context.')) {
          wfAction(id, w.workflowId, 'compact', undefined, cp, out);
        }
      };
      acts2.appendChild(cp);
    }
    if (w.canFold) {
      const fd = document.createElement('button');
      fd.className = 'act'; fd.textContent = 'Fold';
      fd.onclick = () => {
        if (confirm('Fold "' + w.title + '"? Deterministic in-place transcript trim (no model spend).')) {
          wfAction(id, w.workflowId, 'fold', undefined, fd, out);
        }
      };
      acts2.appendChild(fd);
    }
    const ho = document.createElement('button');
    ho.className = 'act'; ho.textContent = 'Handoff';
    ho.onclick = () => {
      if (confirm('Rotate the worker for "' + w.title + '" (same model) to free up context?')) {
        wfAction(id, w.workflowId, 'handoff', undefined, ho, out);
      }
    };
    acts2.appendChild(ho);
  }
  // R2 — the interactive conversation screen (primary); Transcript stays as
  // the read-only fallback view.
  const chat = document.createElement('a');
  chat.className = 'act act-link';
  chat.textContent = 'Chat';
  chat.href = '/api/instances/' + encodeURIComponent(id) + '/workflows/' + encodeURIComponent(w.workflowId) + '/chat';
  acts2.appendChild(chat);
  const tx = document.createElement('a');
  tx.className = 'act act-link';
  tx.textContent = 'Transcript';
  tx.href = '/api/instances/' + encodeURIComponent(id) + '/workflows/' + encodeURIComponent(w.workflowId) + '/transcript';
  tx.target = '_blank'; tx.rel = 'noopener';
  acts2.appendChild(tx);
  row.appendChild(acts2);

  row.appendChild(out);
  return row;
}

// Structural signature — everything that affects rendering EXCEPT volatile
// relative-time fields (heartbeat / lastActivityAt). When unchanged we skip the
// rebuild entirely, so a message box you're scrolling is never torn down.
function sigOf(data) {
  return JSON.stringify((data.instances || []).map(e => ({
    n: e.instance.name, s: e.state, gr: e.instance.gitRevision, sm: e.instance.serviceMode,
    aa: ((e.rollup && e.rollup.authAlerts) || []).map(a => a.provider + ':' + a.since),
    // R3 — cluster grouping changes must re-render.
    cl: (e.clusters || []).map(c => ({
      i: c.clusterId, n: c.name, e: c.efficiencyLevel, b: c.taskBoardMode,
      a: c.autoTurnOnMailbox, nu: c.idleNudgerEnabled, m: c.memberIds,
      d: c.mailboxDepth, p: c.planHead,
    })),
    w: (e.workflows || []).map(w => ({
      i: w.workflowId, t: w.title, st: w.state, p: w.provider, m: w.model,
      d: w.lastTurnDurationMs, x: w.lastMessageText, r: w.lastMessageRole,
      // R1 fields — a parked question/gate or queue change must re-render.
      e: w.effort, c: w.contextPct, z: w.contextZone, ct: w.contextTokens, cw: w.contextWindow,
      q: w.pendingQuestion && w.pendingQuestion.questionId,
      g: (w.pendingGates || []).map(g => g.gateId + ':' + g.resolvable),
      u: (w.queued || []).map(q => q.id),
      cc: w.canCompact, cf: w.canFold,
    })),
  })));
}

let refreshing = false;
let lastSig = '';
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    const data = await fetch('/api/instances').then(r => r.json());
    const list = $('#list');
    $('#status').textContent = (data.instances ? data.instances.length : 0) + ' instance(s) · updated ' + new Date().toLocaleTimeString();
    const sig = sigOf(data);
    // Nothing structural changed → leave the DOM untouched (preserves scroll +
    // avoids flicker). The relative "ago" text drifts slightly until a real
    // change; an acceptable trade for not snapping the message box to top.
    if (sig === lastSig && list.querySelector('.card')) return;
    lastSig = sig;
    // A rebuild IS needed — preserve each message box's scroll position by wfid.
    const scrolls = {};
    list.querySelectorAll('.wf-msg-body[data-wfid]').forEach(el => { scrolls[el.getAttribute('data-wfid')] = el.scrollTop; });
    list.innerHTML = '';
    if (!data.instances || !data.instances.length) {
      list.innerHTML = '<div class="empty">No instances registered.<br>Start an Arco agent pointed at this hub.</div>';
    } else {
      for (const e of data.instances) list.appendChild(card(e));
    }
    list.querySelectorAll('.wf-msg-body[data-wfid]').forEach(el => {
      const v = scrolls[el.getAttribute('data-wfid')];
      if (v != null) el.scrollTop = v;
    });
  } catch (e) {
    $('#status').textContent = 'hub unreachable — retrying…';
  } finally { refreshing = false; }
}
// R6 — ntfy deep links: '#w=<wfid>' scrolls to (and flashes) that workflow's
// row; '#auth' scrolls to the first AUTH banner. Resolved once after the first
// successful render, then cleared so later refreshes don't re-jump.
let deepLinked = false;
function resolveDeepLink() {
  if (deepLinked) return;
  const h = location.hash || '';
  let target = null;
  if (h.startsWith('#w=')) {
    target = document.querySelector('[data-wfrow="' + CSS.escape(decodeURIComponent(h.slice(3))) + '"]');
  } else if (h === '#auth') {
    target = document.querySelector('.auth-banner');
  }
  if (target) {
    deepLinked = true;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.add('deep-linked');
    setTimeout(() => target.classList.remove('deep-linked'), 4000);
  } else if (!h) {
    deepLinked = true; // nothing to resolve
  }
  // Unresolved hash (target not reported yet): retry on the next refresh.
}

async function refreshAndLink() { await refresh(); resolveDeepLink(); }
refreshAndLink();
setInterval(refreshAndLink, 5000);
`;
}

// Standalone read-only transcript page (opened in a new tab). Reuses the hub's
// /console.css for the Arco theme, then its own conversation layout. Rendered
// server-side from the turns the owning service reconstructed.
export function transcriptHtml(
  title: string,
  turns: Array<{ role: 'user' | 'assistant'; text: string; at?: number }>,
  error = false,
): string {
  const esc = (s: string) =>
    String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
  const body = error
    ? `<div class="t-empty">Transcript unavailable — the instance may be offline or the workflow has no history.</div>`
    : turns.length === 0
      ? `<div class="t-empty">No conversation turns yet.</div>`
      : turns
          .map(
            (t) =>
              `<div class="t-turn ${t.role}"><div class="t-role">${t.role}</div><div class="t-text">${esc(t.text)}</div></div>`,
          )
          .join('\n');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0c0e10">
<title>${esc(title)} · transcript</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/console.css">
<style>
  .t-wrap { max-width: 820px; margin: 0 auto; padding: 0 14px 60px; }
  .t-header { position: sticky; top: 0; background: linear-gradient(var(--color-bg), rgba(12,14,16,0.85)); backdrop-filter: blur(6px); border-bottom: 1px solid var(--color-border-hairline); padding: 16px 14px 12px; margin: 0 -14px 18px; }
  .t-title { font-family: var(--font-display); font-size: 18px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--color-accent-primary); text-shadow: 0 0 10px var(--color-accent-primary-glow); }
  .t-meta { font-size: 12px; color: var(--color-fg-muted); letter-spacing: 1px; margin-top: 2px; }
  .t-turn { margin-bottom: 16px; }
  .t-role { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--color-fg-muted); margin-bottom: 4px; }
  .t-turn.user .t-role { color: var(--color-accent-secondary); }
  .t-text { white-space: pre-wrap; word-break: break-word; font-size: 13.5px; line-height: 1.6; padding: 10px 12px; border-radius: 2px; background: var(--color-bg-panel); border: 1px solid var(--color-border-hairline); }
  .t-turn.user .t-text { border-left: 2px solid var(--color-accent-secondary); color: var(--color-accent-secondary-bright); }
  .t-turn.assistant .t-text { border-left: 2px solid var(--color-border-bright); }
  .t-empty { color: var(--color-fg-muted); text-align: center; padding: 50px 0; }
</style>
</head><body>
<div class="t-wrap">
  <div class="t-header">
    <div class="t-title">◇ ${esc(title)}</div>
    <div class="t-meta">full conversation · ${error ? 'unavailable' : turns.length + ' turns'} · read-only</div>
  </div>
  ${body}
</div>
</body></html>`;
}

// R2 (docs/REMOTE_MANAGEMENT.md) - the interactive conversation screen:
// full transcript + composer + incremental poll. This is the "keep the
// conversation going from the phone" surface; the Home cards stay the triage
// view. Poll-based by design (VPS + battery cheap; no streaming over the hub).
export function chatHtml(instanceId: string, workflowId: string, title: string): string {
  const esc = (s: string) =>
    String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
  // Injected as JSON so the page JS stays free of template-literal interpolation.
  const cfg = JSON.stringify({ instanceId, workflowId });
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0c0e10">
<title>${esc(title)} · chat</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/console.css">
<style>
  html, body { height: 100%; }
  body { display: flex; flex-direction: column; }
  .c-header { position: sticky; top: 0; z-index: 10; background: linear-gradient(var(--color-bg), rgba(12,14,16,0.88)); backdrop-filter: blur(6px); border-bottom: 1px solid var(--color-border-hairline); padding: 12px 14px; display: flex; align-items: center; gap: 10px; }
  .c-back { color: var(--color-accent-secondary); text-decoration: none; font-size: 20px; padding: 4px 10px 4px 2px; }
  .c-title { flex: 1; font-family: var(--font-display); font-size: 16px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--color-accent-primary); text-shadow: 0 0 10px var(--color-accent-primary-glow); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .c-busy { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; padding: 3px 8px; border: 1px solid currentColor; border-radius: 2px; color: var(--color-fg-muted); }
  .c-busy.on { color: var(--color-warning); animation: blink 1.2s steps(2) infinite; }
  .c-turns { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 14px 14px 8px; max-width: 820px; width: 100%; margin: 0 auto; box-sizing: border-box; }
  .t-turn { margin-bottom: 14px; }
  .t-role { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--color-fg-muted); margin-bottom: 4px; }
  .t-turn.user .t-role { color: var(--color-accent-secondary); }
  .t-text { white-space: pre-wrap; word-break: break-word; font-size: 13.5px; line-height: 1.6; padding: 10px 12px; border-radius: 2px; background: var(--color-bg-panel); border: 1px solid var(--color-border-hairline); }
  .t-turn.user .t-text { border-left: 2px solid var(--color-accent-secondary); color: var(--color-accent-secondary-bright); }
  .t-turn.assistant .t-text { border-left: 2px solid var(--color-border-bright); }
  .c-empty { color: var(--color-fg-muted); text-align: center; padding: 40px 0; }
  .c-sending { max-width: 820px; margin: 0 auto; width: 100%; box-sizing: border-box; padding: 0 14px 6px; font-size: 12px; color: var(--color-warning); }
  .c-sending:empty { display: none; }
  .c-composer { position: sticky; bottom: 0; background: linear-gradient(rgba(12,14,16,0.85), var(--color-bg)); backdrop-filter: blur(6px); border-top: 1px solid var(--color-border-hairline); padding: 10px 14px calc(10px + env(safe-area-inset-bottom)); }
  .c-composer-inner { display: flex; gap: 8px; max-width: 820px; margin: 0 auto; }
  .c-input { flex: 1; min-height: 48px; max-height: 140px; resize: none; background: var(--color-bg-input); color: var(--color-fg); border: 1px solid var(--color-border-bright); border-radius: 2px; font-family: var(--font-body); font-size: 14px; line-height: 1.5; padding: 12px; }
  .c-send { flex: 0 0 auto; min-width: 76px; min-height: 48px; font-family: var(--font-body); font-size: 13px; letter-spacing: 1px; text-transform: uppercase; background: var(--color-bg-input); color: var(--color-accent-primary); border: 1px solid var(--color-border-bright); border-radius: 2px; cursor: pointer; }
  .c-send:active { background: var(--color-accent-primary); color: var(--color-bg); }
  .c-send:disabled { opacity: 0.4; }
  .c-error { max-width: 820px; margin: 0 auto; width: 100%; box-sizing: border-box; padding: 0 14px 6px; font-size: 12px; color: var(--color-danger); }
  .c-error:empty { display: none; }
</style>
</head><body>
<div class="c-header">
  <a class="c-back" href="/">‹</a>
  <div class="c-title">${esc(title)}</div>
  <div id="busy" class="c-busy">idle</div>
</div>
<div id="turns" class="c-turns"><div class="c-empty">loading…</div></div>
<div id="sending" class="c-sending"></div>
<div id="error" class="c-error"></div>
<div class="c-composer"><div class="c-composer-inner">
  <textarea id="input" class="c-input" placeholder="message…"></textarea>
  <button id="send" class="c-send">Send</button>
</div></div>
<script>
const CFG = ${cfg};
const turnsEl = document.getElementById('turns');
const busyEl = document.getElementById('busy');
const sendingEl = document.getElementById('sending');
const errorEl = document.getElementById('error');
const inputEl = document.getElementById('input');
const sendEl = document.getElementById('send');
let known = 0;
let sawUserSince = false;
const apiBase = '/api/instances/' + encodeURIComponent(CFG.instanceId) + '/workflows/' + encodeURIComponent(CFG.workflowId);

function nearBottom() {
  return turnsEl.scrollHeight - turnsEl.scrollTop - turnsEl.clientHeight < 120;
}
function bubble(turn) {
  const d = document.createElement('div');
  d.className = 't-turn ' + turn.role;
  const r = document.createElement('div');
  r.className = 't-role'; r.textContent = turn.role === 'user' ? 'you' : 'agent';
  const t = document.createElement('div');
  t.className = 't-text'; t.textContent = turn.text;
  d.appendChild(r); d.appendChild(t);
  return d;
}
let polling = false;
async function poll() {
  if (polling) return; polling = true;
  try {
    const res = await fetch(apiBase + '/convo?since=' + known);
    if (!res.ok) { throw new Error('instance unreachable'); }
    const data = await res.json();
    errorEl.textContent = '';
    if (data.totalTurns < known) {
      // Indexes shifted (rotation/compaction) — full resync.
      known = 0;
      turnsEl.innerHTML = '';
      polling = false;
      return poll();
    }
    if (known === 0) turnsEl.innerHTML = '';
    const pin = nearBottom();
    for (const t of (data.turns || [])) {
      turnsEl.appendChild(bubble(t));
      if (t.role === 'user') sawUserSince = true;
    }
    known = data.totalTurns;
    if (known === 0 && !turnsEl.children.length) {
      turnsEl.innerHTML = '<div class="c-empty">No conversation turns yet — say something below.</div>';
    }
    if (sawUserSince) { sendingEl.textContent = ''; sawUserSince = false; }
    busyEl.textContent = data.busy ? 'running' : 'idle';
    busyEl.classList.toggle('on', !!data.busy);
    if (pin && data.turns && data.turns.length) turnsEl.scrollTop = turnsEl.scrollHeight;
  } catch (e) {
    errorEl.textContent = '✗ ' + e.message + ' — retrying…';
  } finally { polling = false; }
}
async function sendMsg() {
  const body = inputEl.value.trim();
  if (!body) return;
  sendEl.disabled = true;
  try {
    const res = await fetch('/api/instances/' + encodeURIComponent(CFG.instanceId) + '/workflow-action', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ action: { type: 'reply', workflowId: CFG.workflowId, body } }),
    });
    const b = await res.json();
    if (!b.ok) { errorEl.textContent = '✗ ' + (b.error || 'send failed'); }
    else {
      inputEl.value = '';
      sendingEl.textContent = '⇥ sent — waiting for it to appear: ' + (body.length > 80 ? body.slice(0, 80) + '…' : body);
      setTimeout(poll, 400);
    }
  } catch (e) {
    errorEl.textContent = '✗ ' + e.message;
  } finally { sendEl.disabled = false; }
}
sendEl.onclick = sendMsg;
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMsg(); }
});
poll().then(() => { turnsEl.scrollTop = turnsEl.scrollHeight; });
setInterval(poll, 4000);
</script>
</body></html>`;
}

// PWA manifest — turns Android Chrome's "Add to Home screen" into a standalone
// install (no URL bar, Arco icon, dark splash). Tailnet-only; no offline SW.
export function consoleManifest(): string {
  return JSON.stringify({
    name: 'Arco Management',
    short_name: 'Arco',
    description: 'Tailnet control plane for Arco workstations',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0c0e10',
    theme_color: '#0c0e10',
    icons: [{ src: '/icon.svg', type: 'image/svg+xml', sizes: 'any', purpose: 'any maskable' }],
  });
}

// On-brand icon: phosphor-green ◇ on near-black, glyph kept in the maskable safe
// zone. SVG (modern Android Chrome renders manifest SVG icons); if a client
// can't, the install still works with a generated letter icon.
export function consoleIconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="104" fill="#0c0e10"/>
  <rect x="8" y="8" width="496" height="496" rx="98" fill="none" stroke="#1a3a22" stroke-width="2"/>
  <g fill="none" stroke="#4af066" stroke-linejoin="round" stroke-width="22" opacity="0.95">
    <polygon points="256,150 362,256 256,362 150,256"/>
  </g>
  <polygon points="256,206 306,256 256,306 206,256" fill="#4af066"/>
</svg>`;
}

export function consoleHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0c0e10">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Arco · Management</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<link rel="apple-touch-icon" href="/icon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/console.css">
</head>
<body>
<div class="wrap">
  <header>
    <div class="title"><span class="diamond">◇</span> Arco <span style="opacity:.5">/</span> Management</div>
    <div class="subtitle">tailnet control plane</div>
  </header>
  <div id="list"><div class="status-line spin">connecting…</div></div>
  <div id="status" class="status-line"></div>
</div>
<script src="/console.js"></script>
</body>
</html>`;
}
