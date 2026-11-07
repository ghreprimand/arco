import { emptyGenesisSeed, type WorkflowConfig } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import { usePlanGenesisStore, type PlanGenesisOrigin } from '../../stores/planGenesisStore';
import { mintTemplateSpawnToken } from '../WorkflowCreator/pendingTemplateApply';

// The token correlates the created workflow with client-only return state.
export function startPlanGenesis(origin: PlanGenesisOrigin, template: WorkflowConfig): boolean {
  const { wsSendRaw: send, connected } = useAppStore.getState();
  if (!send || !connected) {
    useAppStore.getState().pushNotification('error', 'Connect to Arco before starting Genesis.');
    return false;
  }
  const token = mintTemplateSpawnToken();
  const config: WorkflowConfig = {
    name: 'Plan in Genesis',
    kind: 'workflow',
    workingDirectory: origin.cwd,
    primaryProvider: template.primaryProvider,
    primaryModel: template.primaryModel,
    primaryEffort: template.primaryEffort,
    skipPermissions: template.skipPermissions,
    ...(template.providerAccountRef ? { providerAccountRef: template.providerAccountRef } : {}),
    ...(template.claudeTransport ? { claudeTransport: template.claudeTransport } : {}),
    ...(template.codexTransport ? { codexTransport: template.codexTransport } : {}),
    genesisSeed: { ...emptyGenesisSeed(), planOnly: true },
    templateSpawnToken: token,
  };
  usePlanGenesisStore.getState().begin(token, origin);
  try {
    send({ type: 'create_workflow', config });
    return true;
  } catch {
    usePlanGenesisStore.getState().cancelPending(token);
    useAppStore.getState().pushNotification('error', 'Could not start Genesis. Try again.');
    return false;
  }
}
