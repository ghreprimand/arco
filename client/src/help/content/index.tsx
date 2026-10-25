import type { HelpEntry } from './shared';
import { headerHelp } from './header';
import { tabbarHelp } from './tabbar';
import { composerHelp } from './composer';
import { rightPanelHelp } from './rightPanel';
import { clusterHelp } from './cluster';
import { settingsHelp } from './settings';
import { githubHelp } from './github';
import { gitOpsHelp } from './gitOps';
import { recallHelp } from './recall';
import { cookbookHelp } from './cookbook';
import { mediaHelp } from './media';
import { miscHelp } from './misc';
import { chatHelp } from './chat';

export type { HelpEntry };

// Contextual help content registry. Keyed by the data-help attribute value
// on the target element. When an operator clicks a [data-help] element while
// help mode is active, HelpPopover looks up the key here and renders the
// title + body. Assembled from per-area registries (grouped by the first
// dotted segment of each key).
export const HELP_CONTENT: Record<string, HelpEntry> = {
  ...headerHelp,
  ...tabbarHelp,
  ...composerHelp,
  ...rightPanelHelp,
  ...clusterHelp,
  ...settingsHelp,
  ...githubHelp,
  ...gitOpsHelp,
  ...recallHelp,
  ...cookbookHelp,
  ...mediaHelp,
  ...miscHelp,
  ...chatHelp,
};
