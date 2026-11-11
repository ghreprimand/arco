import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { externalImage } from './externalImage.js';

test('accelerator rejects enlarged pixels but accepts rotation and downscaling', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arco-accelerator-'));
  const previous = process.env.PATH;
  try {
    process.env.PATH = directory;
    for (const [width, height, accepted] of [[40, 30, false], [32, 25, false], [24, 32, true], [16, 12, true]] as const) {
      const png = new PNG({ width, height }); png.data.fill(255);
      const script = `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.includes('-version'))console.log('fixture');else if(process.argv.includes('identify'))console.log('32 24');else fs.writeFileSync(process.argv.at(-1).replace(/^png:/,''),Buffer.from('${PNG.sync.write(png).toString('base64')}','base64'));`;
      await writeFile(join(directory, 'magick'), script, { mode: 0o755 });
      const result = await externalImage(Buffer.from('fixture'), 'image/jpeg', 2000);
      assert.equal(result !== null, accepted, `${width}x${height}`);
    }
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
