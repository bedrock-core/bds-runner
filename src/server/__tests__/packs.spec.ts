import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deployPacks, discoverPacks } from '../packs';
import { writeWorldPackReferences } from '../world';

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
    modules: [{ type: 'script', version: [1, 0, 0] }],
  });
  await write('RP', {
    header: { uuid: `${uuidPrefix}-rp`, version: [1, 0, 0], name: `${name} resources` },
    modules: [{ type: 'resources', version: [1, 0, 0] }],
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

  it('discovers arbitrary pack names and several packs of either kind without traversing nested outputs', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-many-packs-'));

    roots.push(tmp);

    for (const [name, type] of [['logic', 'script'], ['content', 'data'], ['textures', 'resources'], ['interface', 'resources']]) {
      await writeFile(path.join(tmp, name, 'manifest.json'), JSON.stringify({
        header: { uuid: name, version: [1, 0, 0] }, modules: [{ type }],
      }));
    }

    await writeFile(path.join(tmp, 'test', 'nested', 'manifest.json'), JSON.stringify({
      header: { uuid: 'nested', version: [1, 0, 0] }, modules: [{ type: 'script' }],
    }));
    const packs = await discoverPacks(tmp);

    expect(packs.map(pack => pack.packId).sort()).toEqual(['content', 'interface', 'logic', 'textures']);
    expect(packs.filter(pack => pack.kind === 'behavior')).toHaveLength(2);
    expect(packs.filter(pack => pack.kind === 'resource')).toHaveLength(2);
    expect(new Set(packs.map(pack => pack.slug)).size).toBe(4);
  });

  it('accepts a behavior-only collection and its single pack directory', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-behavior-only-'));

    roots.push(tmp);
    await writeFile(path.join(tmp, 'gameplay', 'manifest.json'), JSON.stringify({
      header: { uuid: 'logic', version: '1.0.0' }, modules: [{ type: 'script' }],
    }));

    expect((await discoverPacks(tmp)).map(pack => pack.packId)).toEqual(['logic']);
    expect((await discoverPacks(path.join(tmp, 'gameplay'))).map(pack => pack.packId)).toEqual(['logic']);
  });

  it('treats a manifest-bearing input as one pack even when a child also contains a manifest', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-pack-root-'));
    const manifest = JSON.stringify({ header: { uuid: 'outer', version: [1, 0, 0] }, modules: [{ type: 'script' }] });

    roots.push(tmp);
    await writeFile(path.join(tmp, 'manifest.json'), manifest);
    await writeFile(path.join(tmp, 'nested', 'manifest.json'), manifest);

    expect((await discoverPacks(tmp)).map(pack => pack.packId)).toEqual(['outer']);
  });

  it('rejects manifests without a supported pack module', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-other-pack-'));

    roots.push(tmp);
    await writeFile(path.join(tmp, 'manifest.json'), JSON.stringify({
      header: { uuid: 'template', version: [1, 0, 0] }, modules: [{ type: 'world_template' }],
    }));

    await expect(discoverPacks(tmp)).rejects.toThrow(/must declare a data, script or resources module/);
  });

  it('refuses a build with no behavior pack, since nothing could register a test', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-packs-'));

    roots.push(tmp);
    await fs.mkdir(path.join(tmp, 'RP'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'RP', 'manifest.json'),
      JSON.stringify({ header: { uuid: 'r', version: [1, 0, 0] }, modules: [{ type: 'resources' }] }),
    );

    await expect(discoverPacks([tmp])).rejects.toThrow(/no behavior pack/);
  });
});

async function serverTree(): Promise<{ server: string; world: string }> {
  const server = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-server-'));
  const world = path.join(server, 'worlds', 'bc-test');

  roots.push(server);
  await fs.mkdir(world, { recursive: true });

  return { server: await fs.realpath(server), world: await fs.realpath(world) };
}

async function writeFile(file: string, contents = 'keep'): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

describe('deployPacks', () => {
  it('deploys distinct addons to server development folders and activates the deployed versions', async () => {
    const packs = await discoverPacks([await addon('test-addon', 'a'), await addon('test-addon-2', 'b')]);
    const { server, world } = await serverTree();
    const manifests = await Promise.all(packs.map(pack => fs.readFile(path.join(pack.dir, 'manifest.json'), 'utf8')));

    const deployment = await deployPacks(server, world, packs);

    await writeWorldPackReferences(
      world,
      deployment.packs.filter(pack => pack.kind === 'behavior'),
      deployment.packs.filter(pack => pack.kind === 'resource'),
    );

    for (const kind of ['behavior', 'resource'] as const) {
      const suffix = kind === 'behavior' ? 'bp' : 'rp';

      expect((await fs.readdir(path.join(server, `development_${kind}_packs`))).sort())
        .toEqual([`test-addon-2_${suffix}`, `test-addon_${suffix}`]);
      await expect(fs.access(path.join(world, `${kind}_packs`))).rejects.toThrow();
      expect(JSON.parse(await fs.readFile(path.join(world, `world_${kind}_packs.json`), 'utf8')))
        .toEqual(deployment.packs.filter(pack => pack.kind === kind).map(pack => ({ pack_id: pack.packId, version: pack.version })));
    }

    for (const [index, pack] of packs.entries()) {
      const deployed = JSON.parse(await fs.readFile(path.join(server, `development_${pack.kind}_packs`, pack.slug, 'manifest.json'), 'utf8'));

      expect(deployed.header.uuid).toBe(pack.packId);
      expect(deployed.header.version).toEqual(deployment.packs.find(candidate => candidate.packId === pack.packId)!.version);
      expect(await fs.readFile(path.join(pack.dir, 'manifest.json'), 'utf8')).toBe(manifests[index]);
    }
  });

  it('removes stale development and world copies without changing server built-ins or sibling worlds', async () => {
    const packs = await discoverPacks(await addon('test-addon', 'a'));
    const { server, world } = await serverTree();
    const keep = [
      path.join(server, 'behavior_packs', 'vanilla', 'manifest.json'),
      path.join(server, 'resource_packs', 'vanilla', 'manifest.json'),
      path.join(server, 'worlds', 'other', 'resource_packs', 'custom', 'manifest.json'),
      path.join(world, 'level.dat'),
    ];
    const stale = [
      path.join(server, 'development_behavior_packs', 'unused', 'manifest.json'),
      path.join(server, 'development_resource_packs', 'unused', 'manifest.json'),
      path.join(world, 'behavior_packs', 'test-addon_bp', 'manifest.json'),
      path.join(world, 'resource_packs', 'test-addon_rp', 'manifest.json'),
    ];

    for (const file of [...keep, ...stale]) { await writeFile(file); }

    await deployPacks(server, world, packs);

    for (const file of stale) { await expect(fs.access(file)).rejects.toThrow(); }

    for (const file of keep) { expect(await fs.readFile(file, 'utf8')).toBe('keep'); }
  });

  it('replaces edited files and omits removed files and packs on a later run', async () => {
    const first = await discoverPacks(await addon('test-addon', 'a'));
    const second = await discoverPacks(await addon('test-addon-2', 'b'));
    const { server, world } = await serverTree();
    const resource = first.find(pack => pack.kind === 'resource')!;

    await writeFile(path.join(resource.dir, 'textures', 'current.txt'), 'old');
    await writeFile(path.join(resource.dir, 'textures', 'removed.txt'));
    await deployPacks(server, world, [...first, ...second]);
    await fs.writeFile(path.join(resource.dir, 'textures', 'current.txt'), 'new');
    await fs.unlink(path.join(resource.dir, 'textures', 'removed.txt'));
    await deployPacks(server, world, first);

    const deployed = path.join(server, 'development_resource_packs', resource.slug);

    expect(await fs.readFile(path.join(deployed, 'textures', 'current.txt'), 'utf8')).toBe('new');
    expect(await fs.readFile(path.join(resource.dir, 'textures', 'current.txt'), 'utf8')).toBe('new');
    await expect(fs.access(path.join(deployed, 'textures', 'removed.txt'))).rejects.toThrow();
    expect(await fs.readdir(path.join(server, 'development_behavior_packs'))).toEqual(['test-addon_bp']);
    expect(await fs.readdir(path.join(server, 'development_resource_packs'))).toEqual(['test-addon_rp']);
  });

  it.each(['development_resource_packs', 'worlds/bc-test/resource_packs'])('rejects a source inside %s before removing any pack', async (folder) => {
    const packs = await discoverPacks(await addon('test-addon', 'a'));
    const { server, world } = await serverTree();
    const source = path.join(server, folder, 'source');
    const marker = path.join(server, 'development_behavior_packs', 'existing', 'manifest.json');

    await fs.mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'manifest.json'), 'source');
    await writeFile(marker);
    packs[1] = { ...packs[1], dir: source };
    await expect(deployPacks(server, world, packs)).rejects.toThrow(/source overlaps/);
    expect(await fs.readFile(path.join(source, 'manifest.json'), 'utf8')).toBe('source');
    expect(await fs.readFile(marker, 'utf8')).toBe('keep');
  });

  it('rejects a linked development folder without changing its target or the world copies', async () => {
    const packs = await discoverPacks(await addon('test-addon', 'a'));
    const { server, world } = await serverTree();
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-external-'));
    const marker = path.join(world, 'behavior_packs', 'existing', 'manifest.json');

    roots.push(external);
    await writeFile(path.join(external, 'manifest.json'));
    await writeFile(marker);
    await fs.symlink(external, path.join(server, 'development_resource_packs'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(deployPacks(server, world, packs)).rejects.toThrow(/regular directory/);
    expect(await fs.readFile(path.join(external, 'manifest.json'), 'utf8')).toBe('keep');
    expect(await fs.readFile(marker, 'utf8')).toBe('keep');
  });

  it('rejects an unrelated world and an unsafe slug before modifying the server', async () => {
    const packs = await discoverPacks(await addon('test-addon', 'a'));
    const { server, world } = await serverTree();
    const unrelated = await serverTree();
    const marker = path.join(server, 'development_behavior_packs', 'existing', 'manifest.json');

    await writeFile(marker);
    await expect(deployPacks(server, unrelated.world, packs)).rejects.toThrow(/direct child/);
    await expect(deployPacks(server, world, [{ ...packs[0], slug: '../escape' }])).rejects.toThrow(/invalid pack deployment/);
    expect(await fs.readFile(marker, 'utf8')).toBe('keep');
  });
});
