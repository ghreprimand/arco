import { usePublicProject } from '../utils/publicProject';

interface Props {
  cwd: string;
  testId?: string;
  /** Called with the effective value after the user changes it. */
  onChange?: (value: boolean) => void;
  /** For a new project that does not yet have a folder. */
  newProjectValue?: boolean;
}

// "This project is public (or will be)": saved per project in Arco home,
// pre-ticked only when the Git remote is confirmed public.
export function PublicProjectBox({ cwd, testId = 'public-project-box', onChange, newProjectValue }: Props) {
  const { checked, set, reason, hint, error } = usePublicProject(cwd);
  if (!cwd && newProjectValue === undefined) return null;
  return (
    <span data-help="plan.public-project" style={{ display: 'inline-flex', flexDirection: 'column', gap: '2px', fontSize: '11px', color: 'var(--color-fg-muted)' }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
        <input type="checkbox" data-testid={testId} checked={cwd ? checked : Boolean(newProjectValue)} onChange={(event) => { if (cwd) set(event.target.checked); onChange?.(event.target.checked); }} />
        This project is public (or will be)
      </label>
      {error && <span role="alert">{error}</span>}
      {reason && <span data-testid={`${testId}-reason`}>{reason}</span>}
      {!reason && hint && <span data-testid={`${testId}-hint`}>{hint}</span>}
    </span>
  );
}
