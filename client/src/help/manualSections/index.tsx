import type { Section } from '../../components/UserManual/manualTypes';
import { gettingStarted } from './gettingStarted';
import { workspace } from './workspace';
import { workflows } from './workflows';
import { chat } from './chat';
import { clusters } from './clusters';
import { actions } from './actions';
import { providers } from './providers';
import { deepseekGuide } from './deepseek';
import { strataGuide } from './strata';
import { plans } from './plans';
import { configuration } from './configuration';
import { powerFeatures } from './powerFeatures';
import { voice } from './voice';
import { cookbook } from './cookbook';
import { media } from './media';
import { troubleshooting } from './troubleshooting';
import { reference } from './reference';
import { maintenance } from './maintenance';

// ---------------------------------------------------------------------------
// CONTENT — assembled in display order; the TOC and scroll rely on this order.
// ---------------------------------------------------------------------------

export const MANUAL_SECTIONS: Section[] = [
  ...gettingStarted,
  ...workspace,
  ...workflows,
  ...chat,
  ...clusters,
  ...actions,
  ...providers,
  ...strataGuide,
  ...deepseekGuide,
  ...plans,
  ...configuration,
  ...powerFeatures,
  ...voice,
  ...cookbook,
  ...media,
  ...troubleshooting,
  ...maintenance,
  ...reference,
];
