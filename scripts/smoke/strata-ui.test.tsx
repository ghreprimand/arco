import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
(globalThis as any).React = React;
import { FreeVramButton } from '../../client/src/components/FreeVramButton';
import { GenerationSpeedReadout } from '../../client/src/components/GenerationSpeedReadout';
import { effortsForProvider } from '../../client/src/utils/format';

const speed = { decodeTokens: 100, decodeMs: 1000, prefillTokens: 250, prefillMs: 1000 };
test('Strata readout labels engine timing and renders decode + prefill rates', () => {
  const html = renderToStaticMarkup(<GenerationSpeedReadout job={{ config: { primaryProvider: 'strata' } as any, lastGenSpeed: speed }} />);
  assert.match(html, /100 tok\/s/);
  assert.match(html, /PP 250/);
  assert.match(html, /Strata engine/);
  assert.match(html, /cached prompt prefix is excluded/);
});
test('Ollama retains its daemon readout; missing timing and unsupported providers render nothing', () => {
  assert.match(renderToStaticMarkup(<GenerationSpeedReadout job={{ config: { primaryProvider: 'ollama' } as any, lastGenSpeed: speed }} />), /Ollama daemon/);
  assert.equal(renderToStaticMarkup(<GenerationSpeedReadout job={{ config: { primaryProvider: 'strata' } as any }} />), '');
  assert.equal(renderToStaticMarkup(<GenerationSpeedReadout job={{ config: { primaryProvider: 'claude' } as any, lastGenSpeed: speed }} />), '');
});
test('Strata offers none/low/medium/high without widening other provider pickers', () => {
  assert.deepEqual(effortsForProvider('strata'), ['none', 'low', 'medium', 'high']);
  assert.deepEqual(effortsForProvider('ollama'), ['low', 'high']);
  assert(!effortsForProvider('claude').includes('none'));
});

test('disabled FREE VRAM keeps contextual help on an enabled wrapper', () => {
  const html = renderToStaticMarkup(<FreeVramButton />);
  assert.match(html, /<span data-help="header.free-vram"[^>]*><button[^>]*disabled=""/);
  assert.doesNotMatch(html, /<button[^>]*data-help="header.free-vram"/);
});
