import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deployPacks, discoverPacks } from '../packs';

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) { await fs.rm(root, { recursive: true, force: true }); }
});

/**
 * Builds `<tmp>/<addon>/build/test/{BP,RP}` — the exact shape a Regolith `build-test` profile
 * exports, because the collision this suite guards against comes from that shape: every addon's
 * export is called `BP`.
 */
async function addon(name: string, uuidPrefix: string): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-packs-'));

  roots.push(tmp);
  const root = path.join(tmp, name, 'build', 'test');

  const write = async (kind: 'BP' | 'RP', manifest: object): Promise<void> => {
    await fs.mkdir(path.join(root, kind), { recursive: true });
    await fs.writeFile(path.join(root, kind, 'manifest.json'), JSON.stringify(manifest));
  };

  await write('BP', {
    header: { uuid: `${uuidPrefix}-bp`, version: [1, 0, 0], name: `${name} behaviour` },
    modules: [{ type: 'script' }],
  });
  await write('RP', {
    header: { uuid: `${uuidPrefix}-rp`, version: [1, 0, 0], name: `${name} resources` },
    modules: [{ type: 'resources' }],
  });

  return root;
}

describe('discoverPacks', () => {
  it('names each pack after its addon, not after the build directory', async () => {
    const packs = await discoverPacks([await addon('test-addon', 'a')]);

    expect(packs.map(p => p.slug)).toEqual(['test-addon_bp', 'test-addon_rp']);
  });

  it('keeps two addons apart', async () => {
    const packs = await discoverPacks([await addon('test-addon', 'a'), await addon('test-addon-2', 'b')]);

    expect(packs).toHaveLength(4);
    expect(new Set(packs.map(p => p.slug)).size).toBe(4);
    expect(packs.filter(p => p.kind === 'behavior').map(p => p.packId)).toEqual(['a-bp', 'b-bp']);
  });

  it('ignores a root named twice', async () => {
    const root = await addon('test-addon', 'a');
    const packs = await discoverPacks([root, root]);

    expect(packs).toHaveLength(2);
  });

  it('accepts a single root as a bare string', async () => {
    const packs = await discoverPacks(await addon('test-addon', 'a'));

    expect(packs).toHaveLength(2);
  });

  it('refuses a build with no behaviour pack, since nothing could register a test', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-packs-'));

    roots.push(tmp);
    await fs.mkdir(path.join(tmp, 'RP'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'RP', 'manifest.json'),
      JSON.stringify({ header: { uuid: 'r', version: [1, 0, 0] }, modules: [{ type: 'resources' }] }),
    );

    await expect(discoverPacks([tmp])).rejects.toThrow(/no behaviour pack/);
  });
});

describe('deployPacks', () => {
  // Two addons both exporting a directory called `BP` must not collide: a pack is deployed under
  // its addon-derived slug, never under its export basename.
  it('gives every behaviour pack its own folder in the world', async () => {
    const packs = await discoverPacks([await addon('test-addon', 'a'), await addon('test-addon-2', 'b')]);
    const world = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-world-'));

    roots.push(world);
    await deployPacks(world, packs);

    expect((await fs.readdir(path.join(world, 'behavior_packs'))).sort())
      .toEqual(['test-addon-2_bp', 'test-addon_bp']);
    expect((await fs.readdir(path.join(world, 'resource_packs'))).sort())
      .toEqual(['test-addon-2_rp', 'test-addon_rp']);
  });
});
