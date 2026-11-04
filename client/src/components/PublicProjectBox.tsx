import { usePublicProject } from '../utils/publicProject';

interface Props {
  cwd: string;
  testId?: string;
  /** Called with the effective value after the user changes it. */
  onChange?: (value: boolean) => void;
}

// "This project is public (or will be)": remembered per project folder in this
// browser, pre-ticked only when the Git remote is confirmed public.
export function PublicProjectBox({ cwd, testId = 'public-project-box', onChange }: Props) {
  const { checked, set, reason, hint } = usePublicProject(cwd);
  if (!cwd) return null;
  return (
    <span data-help="plan.public-project" style={{ display: 'inline-flex', flexDirection: 'column', gap: '2px', fontSize: '11px', color: 'var(--color-fg-muted)' }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
        <input type="checkbox" data-testid={testId} checked={checked} onChange={(event) => { set(event.target.checked); onChange?.(event.target.checked); }} />
        This project is public (or will be)
      </label>
      {reason && <span data-testid={`${testId}-reason`}>{reason}</span>}
      {!reason && hint && <span data-testid={`${testId}-hint`}>{hint}</span>}
    </span>
  );
}
