import { computerProviderConnected, defaultComputerSelection } from '../utils/computerAvailability';
import { COMPUTER_PROVIDERS, type EffortLevel, type ModelName } from '@arco/shared';
import { useVoiceStore } from './store';
import { useAppStore } from '../stores/appStore';
import { useComputerStore, type ComputerSelection } from '../stores/computerStore';
import { modelsForProvider, type ModelCatalogs } from '../utils/modelCatalog';
import { clampEffortForModel, effortsForModel } from '../utils/format';

let switchComputer: ((selection: ComputerSelection) => void) | null = null;
let unsubscribePrevious: (() => void) | undefined;
export function registerComputerSwitch(fn: (selection: ComputerSelection) => void, unsubscribe?: () => void) {
  unsubscribePrevious?.(); unsubscribePrevious = unsubscribe; switchComputer = fn;
}
export function computerCatalogs(): ModelCatalogs {
  const s = useAppStore.getState();
  return { claude: s.claudeNativeCatalog, codex: s.codexCatalog, cursor: s.cursorCatalog,
    ollamaModels: s.authStatus?.ollama?.installedModels ?? [], strataModels: s.authStatus?.strata?.installedModels ?? [],
    lmstudioModels: [], llamacppModels: [], zaiModels: [] };
}
export function syncComputerDefault(): void {
  const computer = useComputerStore.getState();
  if (!computer.automatic || computer.activeId || computer.pending) return;
  const app = useAppStore.getState();
  const selection = defaultComputerSelection(app.authStatus, app.settings?.enabledProviders ?? {}, computerCatalogs());
  if (selection && JSON.stringify(selection) !== JSON.stringify(computer.selection)) useComputerStore.setState({ selection });
}
export function requestComputerSelection(selection: ComputerSelection): string {
  if (useVoiceStore.getState().commandText !== null) throw Error('Finish or cancel the current capture before changing Computer.');
  if (!useAppStore.getState().connected) throw Error('Disconnected. Computer was not changed.');
  if (!COMPUTER_PROVIDERS.includes(selection.provider)) throw Error('Choose Codex, Claude, Ollama or Strata.');
  if (selection.history === 'none' && selection.provider === 'strata') throw Error('Strata keeps service logs/cache and cannot guarantee no-history. Choose Ollama, Claude or Codex, or keep saved history.');
  if (!['saved', 'none'].includes(selection.history)) throw Error('History must be saved or none.');
  const app = useAppStore.getState();
  if (app.authStatus && !computerProviderConnected(selection.provider, app.authStatus, app.settings?.enabledProviders)) throw Error('This Computer agent is not connected. Choose a connected agent or open Connections.');
  const catalogs = computerCatalogs();
  if (!modelsForProvider(selection.provider, catalogs).includes(selection.model as ModelName)) throw Error('That model is not in the available catalog. Refresh the model list or choose a listed model.');
  if (!effortsForModel(selection.provider, selection.model as ModelName, catalogs.claude, catalogs.codex).includes(selection.effort)) throw Error('That effort is not supported by the selected model.');
  if (!switchComputer) throw Error('Computer controls are not ready.');
  switchComputer(selection);
  return 'Computer change requested. It applies after the current turn and queued requests finish; earlier messages are not copied between selections.';
}
export function controlComputer(args: Record<string, string>): string {
  const state = useComputerStore.getState();
  const s = useAppStore.getState();
  const job = state.activeId ? s.jobs[state.activeId] : Object.values(s.jobs).find((j) => j.config.voiceOperator && !j.config.incognito);
  if (args.action === 'models') {
    const catalogs = computerCatalogs();
    return JSON.stringify(COMPUTER_PROVIDERS.map((provider) => ({ provider, noHistory: provider !== 'strata',
      models: modelsForProvider(provider, catalogs).map((model) => ({ model, efforts: effortsForModel(provider, model, catalogs.claude, catalogs.codex) })) })));
  }
  if (args.action === 'status') return JSON.stringify({ ...state.selection, pending: state.pending, context: job?.config.computerContext, window: job?.contextUsage?.windowSize ?? job?.modelContextWindow });
  if (args.action === 'reset') {
    if (!job) throw Error('Computer has no context yet.');
    s.wsSendRaw?.({ type: 'computer_context_control', workflowId: job.id, action: 'fresh' });
    return 'Full context reset requested after this turn and all queued requests finish. No summary is carried forward.';
  }
  if (!['switch', 'privacy'].includes(args.action)) throw Error('Unknown Computer action.');
  if (args.action === 'privacy' && !args.history) throw Error('Choose saved or none for history.');
  const catalogs = computerCatalogs();
  const provider = (args.provider ?? state.selection.provider) as ComputerSelection['provider'];
  const model = args.model ?? (provider === state.selection.provider ? state.selection.model : '');
  if (!model) throw Error('Call arco_computer models and choose an exact model id first.');
  const effort = (args.effort as EffortLevel | undefined) ?? clampEffortForModel(
    provider === state.selection.provider && model === state.selection.model ? state.selection.effort : 'low',
    provider, model as ModelName, catalogs.claude, catalogs.codex);
  return requestComputerSelection({ provider, model, effort, history: (args.history ?? state.selection.history) as ComputerSelection['history'] });
}
