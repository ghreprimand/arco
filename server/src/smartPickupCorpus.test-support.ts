// Synthetic labeled Smart AUTO-PICKUP corpus (scripts/smoke/fixtures) for the
// evaluator tests; the mapping onto snapshot inputs is shared with the eval
// script (smartPickupCorpus.ts).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORPUS_MAX_INPUT_BYTES, corpusSnapshotInput, type CorpusCase } from './smartPickupCorpus.js';

const here = dirname(fileURLToPath(import.meta.url));
export type { CorpusCase };
export { corpusSnapshotInput };
export const corpus = (JSON.parse(readFileSync(join(here, '../../scripts/smoke/fixtures/smart-auto-pickup-corpus.json'), 'utf8')) as { cases: CorpusCase[] }).cases;
export const MAX = CORPUS_MAX_INPUT_BYTES;
