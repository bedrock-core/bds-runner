import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import nbt from 'prismarine-nbt';
import { afterEach, describe, expect, it } from 'vitest';
import { enableBetaApis } from '../world';

describe('generated world experiments', () => {
  const directories: string[] = [];

  afterEach(async () => {
    for (const directory of directories.splice(0)) {
      if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('bds-world-experiments-')) {
        throw new Error('Unexpected temporary world');
      }

      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  async function world(experiments = true): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bds-world-experiments-'));

    directories.push(directory);
    const root = { type: 'compound', name: '', value: {
      LevelName: { type: 'string', value: 'owned test world' },
      Generator: { type: 'int', value: 1 },
      ...experiments
        ? { experiments: { type: 'compound', value: {
            existing_enabled: { type: 'byte', value: 1 },
            existing_disabled: { type: 'byte', value: 0 },
          } } }
        : {},
    } };
    const body = nbt.writeUncompressed(root as never, 'little');
    const header = Buffer.alloc(8);

    header.writeUInt32LE(10, 0);
    header.writeUInt32LE(body.length, 4);
    await fs.writeFile(path.join(directory, 'level.dat'), Buffer.concat([header, body]));

    return directory;
  }

  it('enables requested experiments and Beta APIs while preserving world data and disabled experiments', async () => {
    const directory = await world();
    const result = await enableBetaApis(directory, ['upcoming_creator_features']);
    const bytes = await fs.readFile(path.join(directory, 'level.dat'));
    const { parsed } = await nbt.parse(bytes.subarray(8), 'little');

    expect(result.changed).toBe(true);
    expect(result.experiments).toContain('gametest');
    expect(result.experiments).toContain('upcoming_creator_features');
    expect(bytes.readUInt32LE(0)).toBe(10);
    expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
    expect(nbt.simplify(parsed)).toMatchObject({ LevelName: 'owned test world', Generator: 2, experiments: {
      existing_enabled: 1, existing_disabled: 0, gametest: 1, upcoming_creator_features: 1,
      experiments_ever_used: 1, saved_with_toggled_experiments: 1,
    } });
    expect((await enableBetaApis(directory, ['upcoming_creator_features'])).changed).toBe(false);
    expect(await fs.readFile(path.join(directory, 'level.dat'))).toEqual(bytes);
  });

  it('creates an experiment compound when the generated world has none', async () => {
    const result = await enableBetaApis(await world(false), ['upcoming_creator_features']);

    expect(result.experiments).toContain('gametest');
    expect(result.experiments).toContain('upcoming_creator_features');
  });

  it('refuses malformed or metadata keys before rewriting the world', async () => {
    const directory = await world();
    const file = path.join(directory, 'level.dat');
    const before = await fs.readFile(file);

    for (const key of ['../outside', 'bad key', 'experiments_ever_used', 'saved_with_toggled_experiments']) {
      await expect(enableBetaApis(directory, [key])).rejects.toThrow('Invalid experiment NBT key');
      expect(await fs.readFile(file)).toEqual(before);
    }
  });
});
