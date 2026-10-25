import { useAppStore } from '../../stores/appStore';
import { useCompareStore } from '../../stores/compareStore';
import { CompareDialog } from './CompareDialog';
import { dispatchCompare } from '../terminalInput/compare';

// Globally-mounted host for the Compare dialog — WORKBENCH_EXPANSION_PLAN.md §B1.
//
// The COMPARE button (TerminalInput) flips compareStore.dialogOpen +
// dialogWorkflowId; this host resolves that workflow's config (for the RUN AS
// picker seed) and renders the dialog. Confirm dispatches the race and closes;
// the results stream into the separately-mounted CompareOverlay. Mounting it
// here (not in TerminalInput) keeps TerminalInput thin.

export function CompareDialogHost() {
  const open = useCompareStore((s) => s.dialogOpen);
  const workflowId = useCompareStore((s) => s.dialogWorkflowId);
  const closeDialog = useCompareStore((s) => s.closeDialog);
  const job = useAppStore((s) => (workflowId ? s.jobs[workflowId] : undefined));

  if (!open || !job) return null;

  return (
    <CompareDialog
      parentConfig={job.config}
      onConfirm={(prompt, legs, blind) => {
        dispatchCompare(job.id, prompt, legs, blind);
        closeDialog();
      }}
      onCancel={closeDialog}
    />
  );
}
