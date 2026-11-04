import { readFileSync } from 'node:fs';

// src/ and dist/ have the same relationship to the server package manifest.
// Capture build metadata once, so every response describes the running process.
export const APP_VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const commit = process.env.ARCO_BUILD_COMMIT?.trim();
export const APP_BUILD = Object.freeze({ version: APP_VERSION, ...(commit ? { commit } : {}) });
