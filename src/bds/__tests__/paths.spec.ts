import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, resolveInstance, serverDir, validateInstanceName } from '../paths';

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

  it('keeps version-named defaults and selects configured instance port pairs', async () => {
    const ordinary = loadConfig({ configPath: await config({}) });

    expect(resolveInstance(ordinary)).toEqual({ port: 19140 });
    expect(serverDir('1.2.3.4')).toBe(path.join(serverDir('1.2.3.4', 'main'), '../1.2.3.4'));
    const configured = loadConfig({ configPath: await config({ instance: 'core', instances: { core: 19780, peer: 19782 } }) });

    expect(resolveInstance(configured)).toEqual({ instance: 'core', port: 19780 });
    expect(resolveInstance(configured, { instance: 'peer' })).toEqual({ instance: 'peer', port: 19782 });
    expect(() => resolveInstance(configured, { port: 19800 })).toThrow('cannot change');
    expect(() => resolveInstance(configured, { instance: 'other' })).toThrow('declared');
  });

  it('rejects non-portable names and overlapping or invalid configured ports', async () => {
    for (const name of ['', '.', '..', '../outside', '/absolute', 'bad/name', 'bad\\name', 'CON', 'nul.exe', 'trailing.']) {
      expect(() => validateInstanceName(name)).toThrow('Invalid BDS instance');
    }

    for (const instances of [{}, [], { main: 80 }, { main: 65535 }, { main: 19780, peer: 19781 }, { Main: 19780, main: 19782 }]) {
      const file = await config({ instances });

      expect(() => loadConfig({ configPath: file })).toThrow();
    }
  });
});
