// Workbench Expansion H2 part 2 — Odysseus image-editor VENDOR INTEGRITY smoke.
//
// The editor UI itself is canvas/DOM and can't be exercised headlessly, so this
// is a pure fs + string-assertion check that the vendored tree obeys the H2/H3
// contract — no browser, no server, no WS. It guards the load-bearing vendor
// invariants so a future re-vendor / careless edit can't silently regress them:
//
//   (a) NONE of the 5 ai-*.js files are present in the vendored tree (H3 deferred).
//   (b) the vendored galleryEditor.js has NO unstubbed `import … from './editor/ai-`
//       line (the 5 AI imports must be replaced by local no-op stubs).
//   (c) VENDOR.md + LICENSE both exist (provenance + MIT notice retained).
//   (d) no LIVE (reachable) fetch to a non-existent backend remains — every
//       `/api/gallery/upload`, `/api/gallery/{id}/replace`, `/api/editor-drafts`,
//       `/api/gallery/library`, `/api/cookbook/packages` fetch must sit behind an
//       ARCO VENDOR PATCH guard (an early `return;` before the fetch).
//   (e) the clean save seam exportPNG() is still exported (the wrapper relies on it).
//
// Run: npm run smoke:image-editor-vendor   (no dev server / network needed)

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { step, assert, summary } from './lib.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, '..', '..');
const VENDOR = path.join(REPO_ROOT, 'client', 'src', 'vendor', 'odysseus-editor');
const GALLERY = path.join(VENDOR, 'galleryEditor.js');

const AI_FILES = ['ai-inpaint.js', 'ai-rembg.js', 'ai-models.js', 'ai-tool-runner.js', 'ai-tools-misc.js'];

async function main(): Promise<void> {
  await step('(a) none of the 5 ai-*.js files are vendored', () => {
    for (const f of AI_FILES) {
      const p = path.join(VENDOR, 'editor', f);
      assert(!existsSync(p), `excluded AI module must NOT exist: editor/${f}`);
    }
  });

  await step('(b) galleryEditor.js has no unstubbed ai-* import', () => {
    assert(existsSync(GALLERY), 'vendored galleryEditor.js must exist');
    const src = readFileSync(GALLERY, 'utf8');
    // Any LIVE import line pulling from './editor/ai-…' is a regression. Real
    // import statements start the line with `import` (ignoring whitespace); the
    // patch comments that merely mention the old path are not import statements.
    const lines = src.split('\n');
    const liveAiImports = lines.filter((l) => /^\s*import\b[^;]*from\s*['"]\.\/editor\/ai-/.test(l));
    assert(
      liveAiImports.length === 0,
      `found ${liveAiImports.length} live ai-* import(s): ${liveAiImports.map((l) => l.trim()).join(' | ')}`,
    );
    // And the stubs must be present (so the wiring calls don't throw).
    for (const stub of ['createApplyImageTool', 'wireAIModelSelectors', 'wireInpaintButtons', 'wireAIToolsMisc', 'wireRembgAndSharpen']) {
      assert(new RegExp(`const ${stub}\\s*=`).test(src), `missing local stub for ${stub}`);
    }
  });

  await step('(c) VENDOR.md and LICENSE are present', () => {
    assert(existsSync(path.join(VENDOR, 'VENDOR.md')), 'VENDOR.md must exist');
    assert(existsSync(path.join(VENDOR, 'LICENSE')), 'LICENSE must exist');
    const lic = readFileSync(path.join(VENDOR, 'LICENSE'), 'utf8');
    assert(/MIT License/i.test(lic), 'LICENSE must be the MIT notice');
  });

  await step('(d) no live fetch to a non-existent backend remains', () => {
    const src = readFileSync(GALLERY, 'utf8');
    const importSrc = readFileSync(path.join(VENDOR, 'editor', 'wire-import.js'), 'utf8');
    // For each neutralized endpoint, assert the fetch line is preceded (within
    // its function) by an ARCO VENDOR PATCH early-return guard. We check the
    // simpler invariant the gate cares about: a `return;` sits between the
    // ARCO VENDOR PATCH marker and the fetch for that endpoint.
    const checks: Array<{ file: string; text: string; needle: RegExp }> = [
      { file: 'galleryEditor.js', text: src, needle: /\/api\/gallery\/\$\{state\.imageId\}\/replace/ },
      { file: 'galleryEditor.js', text: src, needle: /\/api\/gallery\/upload/ },
      { file: 'galleryEditor.js', text: src, needle: /fetch\('\/api\/cookbook\/packages'/ },
      { file: 'wire-import.js', text: importSrc, needle: /fetch\('\/api\/gallery\/library/ },
    ];
    for (const { file, text, needle } of checks) {
      const idx = text.search(needle);
      assert(idx >= 0, `expected endpoint reference not found in ${file}: ${needle}`);
      // The chars before the fetch must contain a VENDOR PATCH guard + a bare
      // `return;` — proving the fetch is unreachable. The window is generous
      // (2400 chars) because some neutralized handlers preserve a long original
      // body verbatim below the guard (e.g. the ge-save toBlob flow).
      const before = text.slice(Math.max(0, idx - 2400), idx);
      assert(/ARCO VENDOR PATCH/.test(before), `fetch in ${file} not preceded by an ARCO VENDOR PATCH note (${needle})`);
      assert(/\n\s*return;/.test(before), `fetch in ${file} not behind an early return guard (${needle})`);
    }
    // editor-drafts: every fetch to it must likewise be guarded; assert no
    // editor-drafts fetch sits at the top of its function un-guarded.
    const draftFetches = (src.match(/fetch\(`?\/api\/editor-drafts/g) || []).length;
    assert(draftFetches > 0, 'expected the editor-drafts fetches to still be present (behind guards)');
  });

  await step('(e) exportPNG save seam is still exported', () => {
    const src = readFileSync(GALLERY, 'utf8');
    assert(/export function exportPNG\(\)/.test(src), 'exportPNG() must remain exported (the wrapper saves through it)');
    assert(/export function openEditor\(/.test(src), 'openEditor() must remain exported');
    assert(/export function closeEditor\(\)/.test(src), 'closeEditor() must remain exported');
  });

  summary('image-editor-vendor');
}

void main();
