import type { ReactNode } from 'react';

export interface Props {
  onClose: () => void;
}

export interface Section {
  id: string;
  title: string;
  group: string;
  body: ReactNode;
}

export const GROUPS = [
  'Getting started',
  'The workspace',
  'Workflows & sessions',
  'Clusters',
  'The six operator actions',
  'Providers',
  'Plans & artifacts',
  'Configuration',
  'Power features',
  'Troubleshooting',
  'Reference',
] as const;
