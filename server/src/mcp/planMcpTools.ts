// Workflow-scoped `arco` MCP tools — plan create / attach / list, plus the
// plan_ref_* reference-doc tools.
//
// Why these exist (2026-07-28): asking a worker to "create a plan and attach it
// to this workflow" produced a confident "Plan attached" that attached nothing.
// Attach was always reachable over REST, but only Claude Native's
// `EnterPlanMode` reaches it via a tool — every other transport had to infer
// that Arco has a local HTTP API and reverse-engineer the route with curl.
// `planAuthoringNote` (turnEngine) papered over that by handing the model the
// exact curl; these tools remove the guessing entirely:
//
//   - no shell, so a restrictive provider sandbox can't block it,
//   - no hand-escaping a multi-KB markdown body through shell quoting AND
//     JSON encoding — the single step most likely to fail,
//   - structural validation with an actionable error, so a plan that would
//     parse to zero reviewable tasks is caught at write time instead of being
//     discovered when per-phase Review comes up empty.
//
// Transport-agnostic by the same split as `clusterMcpTools.ts`: this module
// registers onto an `McpServer`, and both the stdio child (`arcoMcpServer.ts`,
// for CLI Claude and both Codex transports) and Cursor's in-process loopback
// call it. Every tool is a thin translation to Arco's local REST plan API,
// so (workflowId, cwd, port) is the entire context a registration needs.
//
// Model authority: bounded and reversible. Creating/attaching a plan emits the
// usual `plan_attached` event to events.jsonl, shows in the PLAN tab, and the
// operator can detach in one click — the same surface the PLAN tab button
// drives. No new capability is granted; an existing one stops being a puzzle.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export interface PlanMcpToolCtx {
  workflowId: string;
  // The workflow's cwd — every plan REST route is keyed by `?path=<cwd>`.
  cwd: string;
  arcoPort: number;
  // stdio children MUST log to stderr (stdout is the MCP wire).
  logErr?: (...args: unknown[]) => void;
}

function textResult(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

// Mirror of the `parsePlan` contract in `primitives/reviewContent.ts`: phases
// come from `###`, and a task counts only from a TOP-LEVEL `- [ ]` / `- [x]`
// (or the `- **4.1**` numbered fallback). Kept as a local check rather than an
// import because this module is also loaded inside the stdio child, which
// shouldn't drag the review pipeline in with it. If those regexes change,
// change these — `docs/GOTCHAS.md § Plans` says so too.
const H3_RE = /^###\s+\S/;
const TOP_TASK_RE = /^- (?:\[[ xX]\]|\*\*[\d.]+)/;

export function lintPlanBody(body: string): { ok: true } | { ok: false; problems: string[] } {
  const lines = body.split('\n');
  const problems: string[] = [];
  if (!lines.some((l) => H3_RE.test(l))) {
    problems.push('No `### Phase name` headings — the plan will have zero phases, so per-phase Review has nothing to scope to.');
  }
  if (!lines.some((l) => TOP_TASK_RE.test(l))) {
    problems.push('No top-level `- [ ] task` checkbox lines — the plan will parse to zero tasks, so Review and the item picker come up empty. Indented bullets are read as continuations of a task, not as tasks.');
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

// Soft lean-plan check — warnings ride the success result, never refuse. The
// 2026-10 complaint: agents stuffed specs and research into the checklist
// until the plan stopped reading as a plan. Detail belongs in reference docs.
const LEAN_BODY_WARN_BYTES = 12 * 1024;
const LEAN_TASK_WARN_CHARS = 400;

export function leanPlanWarnings(body: string): string[] {
  const warnings: string[] = [];
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > LEAN_BODY_WARN_BYTES) {
    warnings.push(`Plan body is ${Math.round(bytes / 1024)} KB. Keep the plan an itemized checklist; move specs, research, and design detail into reference docs (plan_ref_write) and link them from tasks as [label](ref:slug).`);
  }
  // A task = its top-level line plus continuation lines until the next task/heading.
  let longTasks = 0;
  let cur = -1;
  for (const line of body.split('\n')) {
    if (TOP_TASK_RE.test(line)) { if (cur > LEAN_TASK_WARN_CHARS) longTasks++; cur = line.length; continue; }
    if (/^#{1,6}\s/.test(line)) { if (cur > LEAN_TASK_WARN_CHARS) longTasks++; cur = -1; continue; }
    if (cur >= 0) cur += line.length;
  }
  if (cur > LEAN_TASK_WARN_CHARS) longTasks++;
  if (longTasks > 0) {
    warnings.push(`${longTasks} task(s) carry more than ${LEAN_TASK_WARN_CHARS} characters of prose. Keep each task to a line or two and put the detail in a reference doc.`);
  }
  return warnings;
}

export function registerPlanTools(server: McpServer, ctx: PlanMcpToolCtx): void {
  const BASE = `http://127.0.0.1:${ctx.arcoPort}`;
  const logErr = ctx.logErr ?? ((...a: unknown[]) => console.error('[arco-mcp]', ...a));
  const q = (extra: Record<string, string> = {}) =>
    new URLSearchParams({ path: ctx.cwd, ...extra }).toString();

  server.registerTool(
    'plan_create',
    {
      title: 'Create and attach a project plan',
      description:
        'Create a project plan for THIS Arco workflow and attach it, in one call. Use this whenever the operator asks you to "write a plan", "create a plan", or "attach a plan" — writing a markdown file somewhere does NOT attach a plan and Arco will not see it.\n\n' +
        'The body is parsed, not just displayed: use `### Phase name` for each phase, and make every task a TOP-LEVEL `- [ ] task` checkbox line (indent subtasks beneath their parent). A body without those parses to zero reviewable items, so this tool rejects it unless you pass allowUnstructured.\n\n' +
        'An Arco plan has two parts: a LEAN checklist (one or two lines per task) and its reference docs. Long-form detail (specs, research, designs, API notes, decisions) goes in reference docs, not the checklist and not loose files elsewhere in the repo: create the plan, then call plan_ref_write per doc and link it from every task that depends on it as `[label](ref:slug)`. Workers are told to read a task\'s linked refs before starting it, so a link is how detail reaches them.\n\n' +
        'Once attached, the plan is a working contract: tick items `- [ ]` → `- [x]` as you complete them, and ask the operator before adding new sections. Returns the created plan id.',
      inputSchema: {
        title: z.string().min(1).describe('Short plan title shown in the PLAN tab.'),
        body: z.string().min(1).describe('Full markdown body. `### Phase name` per phase; every task a top-level `- [ ] task` line.'),
        allowUnstructured: z.boolean().optional().describe('Set true ONLY if the operator explicitly wants a prose plan with no phases/checkboxes. Skips the structure check; the plan will have no reviewable items.'),
      },
    },
    async ({ title, body, allowUnstructured }) => {
      if (allowUnstructured !== true) {
        const lint = lintPlanBody(body);
        if (!lint.ok) {
          // Refuse rather than silently create a plan Review can't work with.
          // The operator's escape hatch is `allowUnstructured`.
          return textResult(
            {
              error: 'plan_body_unstructured',
              problems: lint.problems,
              fix: 'Rewrite the body with `### Phase name` headings and top-level `- [ ] task` lines, then call plan_create again. If the operator genuinely wants prose with no checklist, pass allowUnstructured: true.',
            },
            true,
          );
        }
      }
      try {
        const res = await fetch(`${BASE}/api/plans?${q()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, body, workflowId: ctx.workflowId, attach: true }),
        });
        const json = await res.json().catch(() => ({})) as { plan?: { id: string; title: string }; error?: string };
        if (!res.ok || !json.plan) {
          logErr('plan_create failed', res.status, json.error);
          return textResult({ error: json.error ?? `plan create failed (HTTP ${res.status})` }, true);
        }
        const warnings = leanPlanWarnings(body);
        return textResult({
          ok: true,
          planId: json.plan.id,
          title: json.plan.title,
          attached: true,
          file: `.arco/plans/${json.plan.id}.md`,
          refsDir: `.arco/plans/${json.plan.id}.refs/`,
          note: 'Attached to this workflow and visible in the PLAN tab. Tick items off as you complete them.',
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      } catch (err) {
        logErr('plan_create threw', err);
        return textResult({ error: err instanceof Error ? err.message : String(err) }, true);
      }
    },
  );

  server.registerTool(
    'plan_attach',
    {
      title: 'Attach an existing plan',
      description:
        'Attach a plan that already exists in this workspace to THIS workflow (use plan_list to find its id). Detaches whatever plan is currently attached. To author a new plan instead, use plan_create.',
      inputSchema: {
        planId: z.string().min(1).describe('Plan id from plan_list.'),
      },
    },
    async ({ planId }) => {
      try {
        const res = await fetch(`${BASE}/api/plans/attach?${q({ planId, workflowId: ctx.workflowId })}`, { method: 'POST' });
        const json = await res.json().catch(() => ({})) as { ok?: boolean; plan?: { title: string }; error?: string };
        if (!res.ok || json.ok !== true) {
          logErr('plan_attach failed', res.status, json.error);
          return textResult({ error: json.error ?? `plan attach failed (HTTP ${res.status})` }, true);
        }
        return textResult({ ok: true, planId, title: json.plan?.title, attached: true });
      } catch (err) {
        logErr('plan_attach threw', err);
        return textResult({ error: err instanceof Error ? err.message : String(err) }, true);
      }
    },
  );

  server.registerTool(
    'plan_list',
    {
      title: 'List plans in this workspace',
      description:
        'List every plan stored in this cwd (id, title, updatedAt, which workflows it is attached to). Read-only. Use before plan_attach to find an existing plan rather than authoring a duplicate.',
      inputSchema: {},
    },
    async () => {
      try {
        const res = await fetch(`${BASE}/api/plans?${q()}`);
        const json = await res.json().catch(() => ({})) as { plans?: unknown[]; error?: string };
        if (!res.ok) {
          logErr('plan_list failed', res.status, json.error);
          return textResult({ error: json.error ?? `plan list failed (HTTP ${res.status})` }, true);
        }
        return textResult({ plans: json.plans ?? [] });
      } catch (err) {
        logErr('plan_list threw', err);
        return textResult({ error: err instanceof Error ? err.message : String(err) }, true);
      }
    },
  );

  // ── Reference docs ──
  // A ref is plain markdown under .arco/plans/<planId>.refs/<slug>.md; these
  // tools save the shell round-trip and validate slug + size. planId defaults
  // to nothing — the caller passes it (plan_list / plan_create return it), so
  // the tools work for cluster plans too, not just this workflow's.
  const SLUG = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).describe('Lowercase slug, e.g. `auth-flow-spec`. Link it from the plan body as [label](ref:auth-flow-spec).');

  server.registerTool(
    'plan_ref_write',
    {
      title: 'Write a plan reference doc',
      description:
        'Create or replace a reference doc attached to a plan. Use this for long-form detail a plan task depends on — specs, research findings, design notes, API contracts — instead of putting that prose in the plan body. Then link it from the task line as `[label](ref:slug)`. Markdown; the first `# H1` is its title. Max 256 KB per doc.',
      inputSchema: {
        planId: z.string().min(1).describe('Plan id (from plan_create / plan_list / the per-turn plan header).'),
        slug: SLUG,
        body: z.string().min(1).describe('Full markdown body of the reference doc.'),
      },
    },
    async ({ planId, slug, body }) => {
      try {
        const res = await fetch(`${BASE}/api/plans/refs?${q({ planId, slug })}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        });
        const json = await res.json().catch(() => ({})) as { ref?: unknown; created?: boolean; error?: string };
        if (!res.ok) {
          logErr('plan_ref_write failed', res.status, json.error);
          return textResult({ error: json.error ?? `ref write failed (HTTP ${res.status})` }, true);
        }
        return textResult({ ok: true, created: json.created, ref: json.ref, link: `[${slug}](ref:${slug})`, file: `.arco/plans/${planId}.refs/${slug}.md` });
      } catch (err) {
        logErr('plan_ref_write threw', err);
        return textResult({ error: err instanceof Error ? err.message : String(err) }, true);
      }
    },
  );

  server.registerTool(
    'plan_ref_list',
    {
      title: 'List a plan\'s reference docs',
      description: 'List the reference docs attached to a plan (slug, title, size, updatedAt). Read-only.',
      inputSchema: { planId: z.string().min(1).describe('Plan id.') },
    },
    async ({ planId }) => {
      try {
        const res = await fetch(`${BASE}/api/plans/refs?${q({ planId })}`);
        const json = await res.json().catch(() => ({})) as { refs?: unknown[]; error?: string };
        if (!res.ok) return textResult({ error: json.error ?? `ref list failed (HTTP ${res.status})` }, true);
        return textResult({ refs: json.refs ?? [] });
      } catch (err) {
        return textResult({ error: err instanceof Error ? err.message : String(err) }, true);
      }
    },
  );

  server.registerTool(
    'plan_ref_read',
    {
      title: 'Read a plan reference doc',
      description: 'Read one reference doc of a plan by slug — follow a `ref:slug` link from the plan body or a board task. Read the refs a task links before starting that task: the checklist line is the summary, the ref is the spec. Read-only.',
      inputSchema: { planId: z.string().min(1).describe('Plan id.'), slug: SLUG },
    },
    async ({ planId, slug }) => {
      try {
        const res = await fetch(`${BASE}/api/plans/refs/body?${q({ planId, slug })}`);
        const json = await res.json().catch(() => ({})) as { ref?: { body: string; title: string }; error?: string };
        if (!res.ok || !json.ref) return textResult({ error: json.error ?? `ref read failed (HTTP ${res.status})` }, true);
        return textResult(`# ref:${slug} — ${json.ref.title}\n\n${json.ref.body}`);
      } catch (err) {
        return textResult({ error: err instanceof Error ? err.message : String(err) }, true);
      }
    },
  );
}
