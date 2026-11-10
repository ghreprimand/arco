// Shared board descriptors for Native and local-provider tool registries.
// Operations continue through the existing cluster peer APIs.
export interface ClusterTaskToolDefinition {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export const CLUSTER_TASK_TOOL_DEFINITIONS: ClusterTaskToolDefinition[] = [
    {
      name: 'cluster_task_list',
      description:
        "List the shared task board for your cluster (the cwd-scoped project task ledger). Returns each task's id, title, status (triage / todo / ready / in_progress / blocked / review / done / archived), assignee (the workflowId of the member who claimed it, if any), links, and kernel metadata. Use this to find unclaimed work before claiming, or to check who owns what. Read-only - does not mutate. Cluster mode only.",
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'cluster_task_show',
      description:
        'Show full detail for one shared task: task fields, parent tasks, child tasks, durable comments, and recent run records, plus referenceDocs (the plan reference docs the task links - read them before starting). Call this before starting assigned work so you have the latest handoff thread and spec.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from cluster_task_list.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'cluster_task_create',
      description:
        'Create a non-terminal task on the shared cluster board. New tasks start as todo; done/archived remain operator-only. Use title plus optional body/notes, assignee, priority, parentIds, links, reviewRequired, goalMode, and goalMaxTurns. parentIds must refer to existing tasks. When the task implements a plan item, start the title with that item\'s id or text (e.g. \'P6.9 Live tab drag follow on X11\'): cluster_task_show then resolves the item\'s reference docs (its own ref links, its sub-bullets, its phase intro) for whoever works it. Add any extra ref:slug links the task needs to notes.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title. Required and non-empty.' },
          body: { type: 'string', description: 'Initial task body. Alias for notes when notes is absent.' },
          notes: { type: 'string', description: 'Initial task notes.' },
          assignee: { type: 'string', description: 'Optional assignee workflowId or unique workflowId prefix in this cluster.' },
          priority: { type: 'number', description: 'Optional integer priority. Higher numbers sort earlier where supported.' },
          parentIds: { type: 'array', items: { type: 'string' }, description: 'Optional existing parent task ids this task depends on.' },
          links: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['plan', 'review', 'workflow', 'url'] },
                ref: { type: 'string' },
                label: { type: 'string' },
              },
              required: ['kind', 'ref'],
            },
          },
          reviewRequired: { type: 'boolean' },
          goalMode: { type: 'boolean' },
          goalMaxTurns: { type: 'number' },
          release: { type: 'string', description: 'Optional release label such as 0.1.4.' },
        },
        required: ['title'],
      },
    },
    {
      name: 'cluster_task_claim',
      description:
        "Claim a task on the shared cluster board: takes ownership (sets assignee to YOU) and moves it to in_progress. Pass the task `id` from cluster_task_list. If the task is already claimed by a different member, the claim is REJECTED (already_claimed) - coordinate via peer_send before taking it over rather than stomping their work. Re-claiming a task you already own is a no-op.",
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from cluster_task_list.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'cluster_task_update',
      description:
        "Update a task on the shared cluster board. Change its `status` (triage / todo / ready / in_progress / blocked / review), append/replace `notes`, and/or record a `signoff` verdict. IMPORTANT: `done` and `archived` are OPERATOR-ONLY - those statuses are REJECTED here (operator_gated). When you finish work, move the task to review or report completion to the director via peer_send; the operator marks done from the LEDGER tab.\n\nSIGN-OFF (director): when you review a peer's completed task (e.g. one in `review`), set `signoff` to your verdict on whether it met its target - `met`, `not_met`, or `partial` - with a one-line `summary`. This is ADVISORY: it does NOT mark the task done (that stays operator-only); it surfaces a recommendation on the board so the operator can accept at a glance. Sign off as part of the same update where you move the task to `review`. Only the reviewing member (the director) should set this.",
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from cluster_task_list.' },
          status: { type: 'string', enum: ['triage', 'todo', 'ready', 'in_progress', 'blocked', 'review'], description: "New status. 'done' and 'archived' are rejected - operator-only." },
          notes: { type: 'string', description: 'Replacement notes body for the task.' },
          release: { type: 'string', description: 'Release label such as 0.1.4; an empty string clears it.' },
          signoff: {
            type: 'object',
            description: 'Advisory director verdict on whether the task met its target. Does NOT mark it done.',
            properties: {
              state: { type: 'string', enum: ['met', 'not_met', 'partial'], description: 'Your verdict: met / not_met / partial.' },
              summary: { type: 'string', description: 'One-line reason shown on the board card.' },
            },
            required: ['state'],
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'cluster_task_heartbeat',
      description:
        'Record that you are still actively working on a task. Updates or creates your run heartbeat record so cluster_task_show exposes recent run activity. Optional note is stored durably as a heartbeat comment and run metadata.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from cluster_task_list.' },
          note: { type: 'string', description: 'Optional short heartbeat note.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'cluster_task_comment',
      description:
        'Append a durable comment to a shared task. Use this for handoffs, findings, status notes, or questions that should survive across workers and sessions.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from cluster_task_list.' },
          body: { type: 'string', description: 'Comment body.' },
        },
        required: ['id', 'body'],
      },
    },
    {
      name: 'cluster_task_link',
      description:
        'Add a dependency link: childId depends on parentId. The server rejects self-links and cycles. Use this to build a task graph for dispatcher/reviewer workflows.',
      input_schema: {
        type: 'object',
        properties: {
          parentId: { type: 'string', description: 'Task id that must be completed first.' },
          childId: { type: 'string', description: 'Task id that depends on parentId.' },
        },
        required: ['parentId', 'childId'],
      },
    },
    {
      name: 'cluster_task_unlink',
      description:
        'Remove a dependency link: childId no longer depends on parentId. Use carefully; the event is logged and visible to the operator.',
      input_schema: {
        type: 'object',
        properties: {
          parentId: { type: 'string', description: 'Parent dependency task id.' },
          childId: { type: 'string', description: 'Child task id.' },
        },
        required: ['parentId', 'childId'],
      },
    },
    {
      name: 'cluster_task_block',
      description:
        'Block a task with a human-readable reason. Moves the task to blocked, stores blockedReason, and appends a durable BLOCKED comment. Use this when you need operator input, missing context, or a dependency.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from cluster_task_list.' },
          reason: { type: 'string', description: 'Why this task is blocked.' },
        },
        required: ['id', 'reason'],
      },
    },
    {
      name: 'cluster_task_complete',
      description:
        "Submit a completion report for a task YOU OWN. Moves the task to review and appends a durable COMPLETION REPORT comment. You can only complete a task currently assigned to you - completing an unknown id is rejected (not_found) and completing another member's or an unassigned task is rejected (not_owner); claim it first (cluster_task_claim) or coordinate via peer_send. It does NOT mark done; done remains operator-only.",
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from cluster_task_list.' },
          summary: { type: 'string', description: 'What changed, tests run, files touched, and follow-ups.' },
        },
        required: ['id', 'summary'],
      },
    },
];

export const CLUSTER_TASK_TOOL_NAMES = CLUSTER_TASK_TOOL_DEFINITIONS.map(tool => tool.name);
