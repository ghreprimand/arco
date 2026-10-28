import type { AuthLoginTarget } from './providers.js';

export type ConnectionKind = 'plan' | 'local' | 'desktop' | 'tool';
export interface ConnectionDefinition {
  id: AuthLoginTarget;
  label: string;
  kind: ConnectionKind;
  access: string;
  prerequisite: string;
  recovery: string;
  settingsSection: string;
  login?: boolean;
  endpointSetting?: 'ollama' | 'lmstudio' | 'strata';
  environmentKey?: string;
  officialUrl?: string;
}
export interface ConnectionCatalog {
  version: 1;
  checkedOn: string;
  deployment: 'docker' | 'host';
  providers: ConnectionDefinition[];
  // Presence and source only. Never include a credential value or reference.
  environmentKeys: string[];
}
