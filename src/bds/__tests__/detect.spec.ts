import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type DetectedPin, detectFloor, writeDetectedConfig } from '../detect';

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) { await fs.rm(root, { recursive: true, force: true }); }
});

/** A project tree: each key is a path below the root, each value the manifest written there. */
async function project(files: Record<string, unknown>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-detect-'));

  roots.push(root);

  for (const [rel, contents] of Object.entries(files)) {
    const file = path.join(root, rel);

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }

  return root;
}

const manifest = (min: unknown): object => ({
  format_version: 2,
  header: { name: 'p', uuid: 'u', version: [1, 0, 0], min_engine_version: min },
});

describe('detectFloor', () => {
  it('takes the highest min_engine_version any pack declares', async () => {
    const root = await project({
      'packs/BP/manifest.json': manifest([1, 21, 0]),
      'packs/RP/manifest.json': manifest([1, 26, 40]),
    });

    expect(await detectFloor(root)).toEqual({ floor: [1, 26, 40], manifests: 2 });
  });

  it('compares numerically, not as text', async () => {
    const root = await project({
      'a/manifest.json': manifest([1, 26, 9]),
      'b/manifest.json': manifest([1, 26, 40]),
    });

    expect((await detectFloor(root))?.floor).toEqual([1, 26, 40]);
  });

  it('reads the string form as well as the array form', async () => {
    const root = await project({ 'packs/BP/manifest.json': manifest('1.26.40') });

    expect((await detectFloor(root))?.floor).toEqual([1, 26, 40]);
  });

  it('ignores installed packages and build output, so a stale copy cannot win', async () => {
    const root = await project({
      'packs/BP/manifest.json': manifest([1, 21, 0]),
      'node_modules/some-dep/manifest.json': manifest([1, 99, 0]),
      'build/addon_bp/manifest.json': manifest([1, 98, 0]),
      '.bds/server/manifest.json': manifest([1, 97, 0]),
    });

    expect(await detectFloor(root)).toEqual({ floor: [1, 21, 0], manifests: 1 });
  });

  it('skips a manifest that is unreadable or declares nothing', async () => {
    const root = await project({
      'a/manifest.json': '{ not json',
      'b/manifest.json': { header: { name: 'p' } },
      'c/manifest.json': manifest([1, 26, 40]),
    });

    expect(await detectFloor(root)).toEqual({ floor: [1, 26, 40], manifests: 1 });
  });

  it('finds nothing in a project with no manifests, so the caller falls back to latest', async () => {
    expect(await detectFloor(await project({ 'package.json': { name: 'p' } }))).toBeUndefined();
  });
});

describe('writeDetectedConfig', () => {
  const pin: DetectedPin = { version: '1.26.40.8', channel: 'stable', floor: '1.26.40', manifests: 2 };

  it('writes the pin the runner will read back', async () => {
    const root = await project({});
    const file = await writeDetectedConfig(root, pin);

    expect(file).toBe(path.join(root, 'bds-runner.json'));
    expect(JSON.parse(await fs.readFile(file as string, 'utf-8'))).toMatchObject({
      version: '1.26.40.8',
      channel: 'stable',
    });
  });

  it('never overwrites a config the project already has', async () => {
    const root = await project({ 'bds-runner.json': { version: '1.26.50.25', channel: 'preview' } });

    expect(await writeDetectedConfig(root, pin)).toBeUndefined();
    expect(JSON.parse(await fs.readFile(path.join(root, 'bds-runner.json'), 'utf-8')))
      .toMatchObject({ version: '1.26.50.25' });
  });
});
