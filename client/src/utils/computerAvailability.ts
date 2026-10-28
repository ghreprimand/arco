import type { AuthStatusByProvider, ComputerProvider, ProviderName } from '@arco/shared';
import type { ComputerSelection } from '../stores/computerStore';
import { defaultModelForProvider, modelsForProvider, type ModelCatalogs } from './modelCatalog';
import { clampEffortForModel } from './format';

export const NO_COMPUTER_AGENT = 'No Computer agent is connected. Connect Codex, Claude Code, Ollama or Strata in Connections.';
const ORDER: ComputerProvider[] = ['codex', 'claude', 'ollama', 'strata'];
export function computerProviderConnected(provider: ComputerProvider, auth: Partial<AuthStatusByProvider> | null, enabled: Partial<Record<ProviderName, boolean>> = {}): boolean {
  return enabled[provider] !== false && auth?.[provider]?.loggedIn === true;
}
export function defaultComputerSelection(auth: Partial<AuthStatusByProvider> | null, enabled: Partial<Record<ProviderName, boolean>>, catalogs: ModelCatalogs): ComputerSelection | null {
  for (const provider of ORDER) {
    if (!computerProviderConnected(provider, auth, enabled)) continue;
    const models = modelsForProvider(provider, catalogs);
    if (!models.length) continue;
    const model = provider === 'codex' && models.includes('gpt-6-luna') ? 'gpt-6-luna' : defaultModelForProvider(provider, catalogs);
    return { provider, model, effort: clampEffortForModel('low', provider, model, catalogs.claude, catalogs.codex), history: 'saved' };
  }
  return null;
}
