import { useDraftStore } from '../stores/draftStore';
import type { JobState } from '../stores/appStore';

export function TaskChildComposer({ job, canSteer, send }: { job: JobState; canSteer: boolean; send: ((msg: unknown) => boolean | void) | null }) {
  const draft = useDraftStore((s) => s.drafts[job.id] ?? '');
  const pending = useDraftStore((s) => s.taskChildSends[job.id]);
  return <div style={{ padding: 8 }}>
    {canSteer || draft || pending ? <form onSubmit={(event) => {
      event.preventDefault();
      if (!canSteer || !draft.trim() || pending || !job.taskView) return;
      const id = crypto.randomUUID();
      useDraftStore.getState().beginTaskChildSend(job.id, id, draft);
      const sent = send?.({ type: 'task_child_message', workflowId: job.taskView.parentWorkflowId, taskId: job.taskView.taskId, childWorkflowId: job.id, content: draft, clientMessageId: id });
      if (sent === false || !send) useDraftStore.getState().rejectTaskChildSend(job.id, id);
    }}><label>Message running sub-agent <input value={draft} readOnly={!!pending} onChange={(event) => useDraftStore.getState().setDraft(job.id, event.target.value)} /></label>
      {canSteer && <button type="submit" disabled={!draft.trim() || !!pending}>SEND</button>}
      {pending?.state === 'awaiting' && <div role="status">Waiting for Arco to receive the message.</div>}
      {pending?.state === 'unconfirmed' && <div role="status">Delivery is not confirmed. Check the conversation before sending again.</div>}
      {pending?.state === 'rejected' && <div role="status">Message not delivered. The draft is kept here.</div>}
      {pending && pending.state !== 'awaiting' && <button type="button" onClick={() => useDraftStore.getState().releaseTaskChildSend(job.id)}>EDIT DRAFT</button>}
      {canSteer ? <div>A message steers this task and may change its result.</div> : <div>Sub-agent conversation is read-only. The task has ended or cannot accept messages.</div>}
    </form> : <div>Sub-agent conversation is read-only. The task has ended or cannot accept messages.</div>}
  </div>;
}
