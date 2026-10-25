import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { arcoThemes, resolvePalette, contrast, themeCategories } from '../../client/src/phosphor-demo/arco-palette';
import { PHOSPHOR_PREFIX, phosphorTheme } from '../../client/src/phosphor-demo/paletteAdapter';
import { THEME_REGISTRY, CLASSIC_THEME_REGISTRY } from '../../client/src/themes/registry';
import { VALID_THEME_IDS, CLASSIC_THEME_IDS, PHOSPHOR_PALETTE_IDS } from '../../shared/src/protocol/themes';
import { matrix } from '../../client/src/themes/definitions/matrix';
import { phosphorEmission } from '../../client/src/phosphor-demo/emission';

test('softness preserves the reference endpoint and offers a sharper independent default', () => {
  assert.equal(phosphorEmission(0), 'none');
  assert.equal(phosphorEmission(-10), 'none');
  assert.equal(phosphorEmission(100), '0 0 2px currentColor,0 0 7px color-mix(in srgb,currentColor 54%,transparent),0 0 20px color-mix(in srgb,currentColor 24%,transparent),0.7px 0 1px rgba(255,51,68,0.15),-0.7px 0 1px rgba(0,255,255,0.15)');
  assert.equal(phosphorEmission(101), phosphorEmission(100));
  assert.equal(phosphorEmission(NaN), phosphorEmission(50));
  assert.match(phosphorEmission(50), /0 0 1px currentColor,0 0 3.5px/);
});

test('local catalog is byte-identical to the inspected reference snapshot', () => {
  const source = readFileSync(new URL('../../client/src/themes/phosphor/arco-palette.ts', import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), '286fa0ebce77c7b60c94205e90c8ed11067b7f3f1480f8e2b77a787ab7f50ed2');
  assert.equal(arcoThemes.length, 68);
  assert.equal(new Set(arcoThemes.map(t => t.id)).size, 68);
  assert.equal(themeCategories.length, 8);
  assert.deepEqual(new Set(arcoThemes.map(t => t.category)), new Set(themeCategories));
  assert.deepEqual(PHOSPHOR_PALETTE_IDS, arcoThemes.map(t => t.id));
});
test('every imported palette has a collision-free ID and identical presentation structure', () => {
  const reference = phosphorTheme('arco-crt');
  for (const original of arcoThemes) {
    const theme = phosphorTheme(PHOSPHOR_PREFIX + original.id);
    assert.equal(theme.name, original.name);
    assert.equal(theme.id, PHOSPHOR_PREFIX + original.id);
    assert.ok(!CLASSIC_THEME_REGISTRY[theme.id]);
    assert.deepEqual(THEME_REGISTRY[theme.id], theme);
    assert.deepEqual(theme.fonts, reference.fonts);
    assert.deepEqual(theme.density, reference.density);
    assert.deepEqual(theme.animations, reference.animations);
    assert.equal(theme.shaderPreset, 'none');
    for (const key of Object.keys(matrix.tokens)) assert.ok(theme.tokens[key], `${theme.id}: missing ${key}`);
    for (const [key, value] of Object.entries(theme.tokens)) assert.ok(value && !value.includes('undefined') && !value.includes('NaN'), `${theme.id}: invalid ${key}`);
    const palette = resolvePalette(original.id);
    for (const foreground of ['--text-primary', '--text-muted', '--accent', '--red', '--green', '--orange', '--blue', '--purple']) {
      for (const bg of ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-input']) assert.ok(contrast(palette[foreground], palette[bg]) >= 4.5, `${original.id}: ${foreground} / ${bg}`);
    }
  }
});
test('both families match the persistent server contract; Classic IDs remain unchanged', () => {
  assert.deepEqual(Object.keys(THEME_REGISTRY).sort(), [...VALID_THEME_IDS].sort());
  assert.equal(Object.keys(THEME_REGISTRY).length, 111);
  assert.deepEqual(Object.keys(CLASSIC_THEME_REGISTRY).sort(), [...CLASSIC_THEME_IDS].sort());
  assert.equal(Object.keys(CLASSIC_THEME_REGISTRY).length, 43);
  assert.equal(THEME_REGISTRY.everforest.id, 'everforest');
  assert.equal(THEME_REGISTRY['red-planet'].id, 'red-planet');
  assert.throws(() => phosphorTheme('not-in-the-catalog'));
});
test('ambient shader contains no time-dependent sweep or brightness modulation', () => {
  const shader = readFileSync(new URL('../../client/src/themes/phosphor/ambient.frag.glsl', import.meta.url), 'utf8');
  assert.ok(!/uniform\s+float\s+time|time\s*\*/.test(shader));
});
