const NO_SHELL = 'You have no shell and no project files.';
const SANDBOXED_SHELL = 'You may use shell tools inside the sandbox. Project files are unavailable.';

/** Adapt the researcher instructions only when a mandatory CLI fence is active. */
export function cliResearcherDoctrine(doctrine: string): string {
  const first = doctrine.indexOf(NO_SHELL);
  if (first < 0 || doctrine.indexOf(NO_SHELL, first + NO_SHELL.length) >= 0) throw new Error('Researcher instructions are unavailable for the CLI fence.');
  return doctrine.slice(0, first) + SANDBOXED_SHELL + doctrine.slice(first + NO_SHELL.length);
}
