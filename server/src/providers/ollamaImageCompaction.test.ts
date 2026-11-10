import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const home = await mkdtemp(join(tmpdir(), 'arco-image-estimate-'));
installIsolatedTestHome(home);
test.after(() => rm(home, { recursive: true, force: true }));
const { OllamaProvider } = await import('./ollama.js');
const { patchSettings } = await import('../settings.js');

test('Ollama compaction counts only the images admitted by the serving model', async () => {
  await patchSettings({ ollama: { compaction: { enabled: true, contextFillThreshold: 0.85, warnThreshold: 0.75, keepLastMessages: 2 } } } as any);
  const image = new PNG({ width: 2000, height: 2000 }); image.data.fill(255);
  const encoded = PNG.sync.write(image).toString('base64');
  for (const vision of [false, true]) {
    const worker = OllamaProvider.create('fixture', { cwd: home, model: 'fixture', effort: 'medium' } as any) as any;
    let summaries = 0;
    worker.produceCompactionSummary = async () => { summaries++; return 'Earlier work.'; };
    const messages = [{ role: 'system', content: 'Fixture' }, { role: 'user', content: 'Earlier image', images: [encoded, encoded, encoded, encoded] }, ...Array.from({ length: 14 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'Earlier work' }))];
    const baseUrl = 'http://fixture.invalid';
    await worker.maybeCompact(messages, undefined, [{ baseUrl }], {}, {
      modelCache: new Map(), resolvedModelByBase: new Map([[baseUrl, 'fixture']]),
      showCache: new Map([[baseUrl, { numCtx: 8192, archCtx: 8192, capabilities: vision ? ['vision'] : [] }]]),
      lastChosen: null,
    });
    assert.equal(summaries, vision ? 1 : 0, `vision=${vision}`);
  }
});
