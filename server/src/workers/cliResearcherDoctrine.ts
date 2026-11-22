const NO_SHELL = 'You have no shell and no project files.';
const SANDBOXED_SHELL = 'You may use shell tools inside the sandbox. Project files are unavailable.';

/** Adapt the researcher instructions only when a mandatory CLI fence is active. */
export function cliResearcherDoctrine(doctrine: string): string {
  const first = doctrine.indexOf(NO_SHELL);
  if (first < 0 || doctrine.indexOf(NO_SHELL, first + NO_SHELL.length) >= 0) throw new Error('Researcher instructions are unavailable for the CLI fence.');
  return doctrine.slice(0, first) + SANDBOXED_SHELL + doctrine.slice(first + NO_SHELL.length);
}

const RESEARCH_TOOLS = 'Use your research tools (web search and web fetch) for every factual claim.';
const CURSOR_RESEARCH_TOOLS = 'Use your web search tool to find sources and fetch pages with curl in your shell, for every factual claim. Cursor\'s web fetch tool is unavailable.';

/** Cursor's web fetch tool is denied inside the fence; pages come through the shell and Arco's web filter. */
export function cursorResearcherDoctrine(doctrine: string): string {
  const adapted = cliResearcherDoctrine(doctrine);
  const first = adapted.indexOf(RESEARCH_TOOLS);
  if (first < 0 || adapted.indexOf(RESEARCH_TOOLS, first + RESEARCH_TOOLS.length) >= 0) throw new Error('Researcher instructions are unavailable for the Cursor fence.');
  return adapted.slice(0, first) + CURSOR_RESEARCH_TOOLS + adapted.slice(first + RESEARCH_TOOLS.length);
}
