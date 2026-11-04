import { ProviderReleasesModal } from './ProviderReleasesModal';

export function OllamaReleasesModal(props: { onClose: () => void; installedVersion?: string }) {
  return <ProviderReleasesModal {...props} runtime="ollama" />;
}
