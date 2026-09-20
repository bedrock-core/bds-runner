import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { optimizePacks } from '../optimize';

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) { await fs.rm(root, { recursive: true, force: true }); }
});

describe('optimizePacks', () => {
  it('refuses an output ancestor before it can clear an input pack', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-optimize-'));
    const packs = path.join(root, 'packs');
    const manifest = path.join(packs, 'example', 'manifest.json');

    roots.push(root);
    await fs.mkdir(path.dirname(manifest), { recursive: true });
    await fs.writeFile(manifest, '{"header":{}}\n');

    await expect(optimizePacks({ packsDir: packs, outDir: root }))
      .rejects.toThrow(/overlaps --packs/);

    await expect(fs.readFile(manifest, 'utf8')).resolves.toBe('{"header":{}}\n');
  });
});
