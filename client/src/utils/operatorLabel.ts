import { useAppStore } from '../stores/appStore';

// Operator-configurable chat role label. Falls back to "OPERATOR" when the
// setting is unset or empty so the chat reads the same as before for users
// who never touch the field. Uppercased to match the system display style.
export function useOperatorLabel(): string {
  const name = useAppStore((s) => s.settings?.operatorName);
  const trimmed = name?.trim();
  return trimmed ? trimmed.toUpperCase() : 'OPERATOR';
}
