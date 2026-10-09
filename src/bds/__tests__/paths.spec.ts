import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../paths';

describe('configured world experiments', () => {
  const directories: string[] = [];

  afterEach(async () => {
    for (const directory of directories.splice(0)) {
      if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('bds-config-experiments-')) {
        throw new Error('Unexpected temporary configuration');
      }

      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  async function config(value: unknown): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bds-config-experiments-'));
    const file = path.join(directory, 'bds-runner.json');

    directories.push(directory);
    await fs.writeFile(file, JSON.stringify(value));

    return file;
  }

  it('retains explicit experiments and preserves the default shape when they are omitted', async () => {
    const file = await config({ experiments: ['upcoming_creator_features'] });

    expect(loadConfig({ configPath: file }).experiments).toEqual(['upcoming_creator_features']);
    expect(loadConfig({ configPath: await config({}) })).not.toHaveProperty('experiments');
    expect(loadConfig({ configPath: await config({ experiments: [] }) }).experiments).toEqual([]);
  });

  it('rejects duplicate, malformed, non-array, and experiment metadata values', async () => {
    for (const experiments of [null, 'gametest', [1], ['bad key'], ['../outside'],
      ['gametest', 'gametest'], ['experiments_ever_used'], ['saved_with_toggled_experiments']]) {
      const file = await config({ experiments });

      expect(() => loadConfig({ configPath: file })).toThrow('unique experiment NBT keys');
    }
  });
});
