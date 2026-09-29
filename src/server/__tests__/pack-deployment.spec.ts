import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { deployPacks, discoverPacks, type PackVersion } from '../packs';

interface TestManifest {
  format_version: number;
  header: { uuid: string; version: PackVersion; name: string };
  modules: { type: string; uuid: string; version: PackVersion }[];
  dependencies?: { uuid?: string; module_name?: string; version: PackVersion }[];
  metadata?: { authors: string[] };
}

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) { await fs.rm(root, { recursive: true, force: true }); }
});

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function readManifest(dir: string): Promise<TestManifest> {
  return JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as TestManifest;
}

function label(version: PackVersion): string {
  return typeof version === 'string' ? version : version.join('.');
}

async function fixture(): Promise<{
  server: string;
  world: string;
  behavior: string;
  base: string;
  screen: string;
  packs: Awaited<ReturnType<typeof discoverPacks>>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-resource-version-'));
  const server = path.join(root, 'server');
  const world = path.join(server, 'worlds', 'test');
  const behavior = path.join(root, 'source', 'behavior');
  const base = path.join(root, 'source', 'base');
  const screen = path.join(root, 'source', 'screen');

  roots.push(root);
  await fs.mkdir(world, { recursive: true });

  const manifests: [string, TestManifest][] = [
    [behavior, {
      format_version: 3,
      header: { uuid: 'behavior-id', version: '2.0.0', name: 'Behavior' },
      modules: [{ type: 'script', uuid: 'behavior-module', version: '2.0.0' }],
      dependencies: [
        { uuid: 'base-id', version: '1.0.0' },
        { uuid: 'screen-id', version: '1.0.0' },
        { uuid: 'external-id', version: '1.5.0' },
        { module_name: '@minecraft/server-gametest', version: '1.0.0-beta' },
      ],
    }],
    [base, {
      format_version: 2,
      header: { uuid: 'base-id', version: [1, 0, 0], name: 'Base' },
      modules: [{ type: 'resources', uuid: 'base-module', version: [1, 0, 0] }],
      metadata: { authors: ['Test author'] },
    }],
    [screen, {
      format_version: 3,
      header: { uuid: 'screen-id', version: '1.0.0', name: 'Screen' },
      modules: [{ type: 'resources', uuid: 'screen-module', version: '1.0.0' }],
      dependencies: [{ uuid: 'base-id', version: '1.0.0' }],
    }],
  ];

  for (const [dir, manifest] of manifests) { await write(path.join(dir, 'manifest.json'), JSON.stringify(manifest)); }

  await write(path.join(base, 'assets', 'button.txt'), 'A');
  await write(path.join(screen, 'assets', 'label.txt'), 'Screen');

  return { server, world, behavior, base, screen, packs: await discoverPacks([behavior, base, screen]) };
}

describe('resource deployment versions', () => {
  it('preserves source identities and version representations while rewriting resource dependencies', async () => {
    const setup = await fixture();
    const before = structuredClone(setup.packs);
    const sourceText = await Promise.all(setup.packs.map(pack => fs.readFile(path.join(pack.dir, 'manifest.json'), 'utf8')));
    const deployment = await deployPacks(setup.server, setup.world, setup.packs);
    const base = deployment.packs.find(pack => pack.packId === 'base-id')!;
    const screen = deployment.packs.find(pack => pack.packId === 'screen-id')!;
    const behavior = deployment.packs.find(pack => pack.packId === 'behavior-id')!;
    const baseManifest = await readManifest(base.dir);
    const screenManifest = await readManifest(screen.dir);
    const behaviorManifest = await readManifest(behavior.dir);

    expect(setup.packs).toEqual(before);
    expect(base.version).not.toEqual([1, 0, 0]);
    expect(Array.isArray(base.version)).toBe(true);
    expect(typeof screen.version).toBe('string');
    expect(label(base.version)).toBe(screen.version);
    expect(base.sourceVersion).toEqual([1, 0, 0]);
    expect(screen.sourceVersion).toBe('1.0.0');
    expect(baseManifest.header.uuid).toBe('base-id');
    expect(baseManifest.modules).toEqual([{ type: 'resources', uuid: 'base-module', version: base.version }]);
    expect(baseManifest.metadata).toEqual({ authors: ['Test author'] });
    expect(screenManifest.modules[0].version).toBe(screen.version);
    expect(screenManifest.dependencies).toEqual([{ uuid: 'base-id', version: screen.version }]);
    expect(behaviorManifest.header.version).toBe('2.0.0');
    expect(behaviorManifest.modules[0].version).toBe('2.0.0');
    expect(behaviorManifest.dependencies).toEqual([
      { uuid: 'base-id', version: screen.version },
      { uuid: 'screen-id', version: screen.version },
      { uuid: 'external-id', version: '1.5.0' },
      { module_name: '@minecraft/server-gametest', version: '1.0.0-beta' },
    ]);

    for (const [index, pack] of setup.packs.entries()) {
      expect(await fs.readFile(path.join(pack.dir, 'manifest.json'), 'utf8')).toBe(sourceText[index]);
    }

    const record = JSON.parse(await fs.readFile(deployment.recordFile, 'utf8'));

    expect(record.resourceStackHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.packs).toEqual(deployment.packs);
    expect(record.versionDigests[screen.version as string]).toBe(deployment.resourceStackHash);
    expect(record.resourceVersion.every((part: number) => Number.isInteger(part) && part >= 0 && part <= 65_535)).toBe(true);
  });

  it('is deterministic across locations, timestamps, pack order and repeated deployment', async () => {
    const first = await fixture();
    const second = await fixture();
    const a = await deployPacks(first.server, first.world, first.packs);

    await fs.utimes(path.join(second.base, 'assets', 'button.txt'), 1, 1);
    const b = await deployPacks(second.server, second.world, [...second.packs].reverse());
    const repeated = await deployPacks(first.server, first.world, first.packs);

    expect(b.resourceStackHash).toBe(a.resourceStackHash);
    expect(repeated.resourceStackHash).toBe(a.resourceStackHash);
    expect(b.packs.find(pack => pack.packId === 'base-id')!.version)
      .toEqual(a.packs.find(pack => pack.packId === 'base-id')!.version);
    expect(Object.keys(JSON.parse(await fs.readFile(repeated.recordFile, 'utf8')).versionDigests)).toHaveLength(1);
  });

  it('changes the whole stack for resource edits, additions, renames and deletions', async () => {
    const setup = await fixture();
    const first = await deployPacks(setup.server, setup.world, setup.packs);
    const edited = path.join(setup.base, 'assets', 'button.txt');

    await fs.writeFile(edited, 'B');
    const changed = await deployPacks(setup.server, setup.world, setup.packs);

    expect(changed.resourceStackHash).not.toBe(first.resourceStackHash);

    for (const pack of changed.packs.filter(pack => pack.kind === 'resource')) {
      expect(pack.version).not.toEqual(first.packs.find(previous => previous.packId === pack.packId)!.version);
    }

    await fs.writeFile(edited, 'A');
    const addedFile = path.join(setup.screen, 'assets', 'new.txt');

    await fs.writeFile(addedFile, 'new');
    const added = await deployPacks(setup.server, setup.world, setup.packs);

    await fs.rename(addedFile, path.join(setup.screen, 'assets', 'renamed.txt'));
    const renamed = await deployPacks(setup.server, setup.world, setup.packs);

    await fs.unlink(path.join(setup.screen, 'assets', 'renamed.txt'));
    const deleted = await deployPacks(setup.server, setup.world, setup.packs);

    expect(new Set([first.resourceStackHash, changed.resourceStackHash, added.resourceStackHash, renamed.resourceStackHash]).size).toBe(4);
    expect(deleted.resourceStackHash).toBe(first.resourceStackHash);
  });

  it('does not invalidate resources when only behavior scripts change', async () => {
    const setup = await fixture();
    const first = await deployPacks(setup.server, setup.world, setup.packs);

    await write(path.join(setup.behavior, 'scripts', 'main.js'), 'changed');
    const second = await deployPacks(setup.server, setup.world, setup.packs);

    expect(second.resourceStackHash).toBe(first.resourceStackHash);
    expect(second.packs.find(pack => pack.kind === 'behavior')!.version).toBe('2.0.0');
  });

  it('rejects mismatched source dependency versions before rewriting them', async () => {
    const setup = await fixture();
    const manifest = await readManifest(setup.behavior);

    manifest.dependencies![0].version = '9.0.0';
    await fs.writeFile(path.join(setup.behavior, 'manifest.json'), JSON.stringify(manifest));
    await expect(deployPacks(setup.server, setup.world, setup.packs)).rejects.toThrow(/requires base-id at 9.0.0/);
    expect((await readManifest(path.join(setup.server, 'development_resource_packs', 'base_rp'))).header.version).toEqual([1, 0, 0]);
    expect((await readManifest(setup.behavior)).dependencies![0].version).toBe('9.0.0');
    await expect(fs.access(path.join(setup.server, 'pack-deployment.json'))).rejects.toThrow();
  });

  it('rejects a known truncated-version collision without replacing its evidence', async () => {
    const setup = await fixture();
    const first = await deployPacks(setup.server, setup.world, setup.packs);
    const record = JSON.parse(await fs.readFile(first.recordFile, 'utf8'));
    const resource = first.packs.find(pack => pack.kind === 'resource')!;

    record.versionDigests[label(resource.version)] = '0'.repeat(64);
    const poisoned = JSON.stringify(record);

    await fs.writeFile(first.recordFile, poisoned);
    await expect(deployPacks(setup.server, setup.world, setup.packs)).rejects.toThrow(/version collision/);
    expect(await fs.readFile(first.recordFile, 'utf8')).toBe(poisoned);
    expect((await readManifest(setup.base)).header.version).toEqual([1, 0, 0]);
  });

  it.each([null, { formatVersion: 2, versionDigests: {} }, { formatVersion: 1, versionDigests: { '1.2.3': 'bad' } }])('rejects invalid collision history before deleting managed copies: %j', async (record) => {
    const setup = await fixture();
    const marker = path.join(setup.server, 'development_resource_packs', 'keep.txt');

    await write(marker, 'keep');
    await fs.writeFile(path.join(setup.server, 'pack-deployment.json'), JSON.stringify(record));
    await expect(deployPacks(setup.server, setup.world, setup.packs)).rejects.toThrow(/deployment record/);
    expect(await fs.readFile(marker, 'utf8')).toBe('keep');
  });

  it('rejects a linked record before deleting managed copies', async () => {
    const setup = await fixture();
    const external = path.join(setup.server, 'external');
    const marker = path.join(setup.server, 'development_resource_packs', 'keep.txt');

    await write(marker, 'keep');
    await write(path.join(external, 'keep.txt'), 'external');
    await fs.symlink(external, path.join(setup.server, 'pack-deployment.json'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(deployPacks(setup.server, setup.world, setup.packs)).rejects.toThrow(/regular file/);
    expect(await fs.readFile(marker, 'utf8')).toBe('keep');
    expect(await fs.readFile(path.join(external, 'keep.txt'), 'utf8')).toBe('external');
  });

  it('hashes and records completed copies when source content changes after copying', async () => {
    const expected = await fixture();
    const expectedDeployment = await deployPacks(expected.server, expected.world, expected.packs);
    const setup = await fixture();
    const copy = fs.cp.bind(fs);
    const spy = vi.spyOn(fs, 'cp').mockImplementation(async (source, destination, options) => {
      await copy(source, destination, options);

      if (source === setup.base) {
        const manifest = await readManifest(setup.base);

        manifest.header.version = [3, 0, 0];
        await fs.writeFile(path.join(setup.base, 'manifest.json'), JSON.stringify(manifest));
        await fs.writeFile(path.join(setup.base, 'assets', 'button.txt'), 'B');
      }
    });

    try {
      const deployed = await deployPacks(setup.server, setup.world, setup.packs);

      expect(deployed.resourceStackHash).toBe(expectedDeployment.resourceStackHash);
      expect(deployed.packs.find(pack => pack.packId === 'base-id')!.sourceVersion).toEqual([1, 0, 0]);
      expect((await readManifest(setup.base)).header.version).toEqual([3, 0, 0]);
    } finally {
      spy.mockRestore();
    }
  });

  it('rewrites read-only copied manifests while preserving source bytes and permissions', async () => {
    const setup = await fixture();
    const files = [setup.behavior, setup.base].map(dir => path.join(dir, 'manifest.json'));
    const original = await Promise.all(files.map(file => fs.readFile(file, 'utf8')));

    for (const file of files) { await fs.chmod(file, 0o444); }

    const deployment = await deployPacks(setup.server, setup.world, setup.packs);

    for (const [index, file] of files.entries()) {
      expect(await fs.readFile(file, 'utf8')).toBe(original[index]);
      expect((await fs.stat(file)).mode & 0o200).toBe(0);
    }

    const base = deployment.packs.find(pack => pack.packId === 'base-id')!;
    const behavior = deployment.packs.find(pack => pack.packId === 'behavior-id')!;

    expect((await readManifest(base.dir)).header.version).toEqual(base.version);
    expect((await readManifest(behavior.dir)).dependencies![0].version).toBe(label(base.version));
  });

  it('keeps behavior-only deployments byte-identical and records no resource version', async () => {
    const setup = await fixture();
    const manifest = await readManifest(setup.behavior);

    manifest.dependencies = [{ module_name: '@minecraft/server-gametest', version: '1.0.0-beta' }];
    const original = JSON.stringify(manifest);

    await fs.writeFile(path.join(setup.behavior, 'manifest.json'), original);
    const deployment = await deployPacks(setup.server, setup.world, setup.packs.filter(pack => pack.kind === 'behavior'));

    expect(deployment.resourceStackHash).toBeNull();
    expect(await fs.readFile(path.join(deployment.packs[0].dir, 'manifest.json'), 'utf8')).toBe(original);
    expect(deployment.packs[0].version).toBe('2.0.0');
  });
});
