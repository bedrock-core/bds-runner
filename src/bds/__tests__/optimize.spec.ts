import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OptimizeMode, optimizePacks } from '../optimize';

const { spawn, resolveBds } = vi.hoisted(() => ({ spawn: vi.fn(), resolveBds: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn }));
vi.mock('../resolve', () => ({ resolveBds }));

const roots: string[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('BC_BDS_VERSION', 'latest');
  vi.stubEnv('BC_BDS_CHANNEL', 'preview');
  resolveBds.mockResolvedValue({ dir: 'fixture-server', version: '1.26.70.23', source: 'cache' });
});

afterEach(() => { vi.unstubAllEnvs(); });

afterAll(async () => {
  for (const root of roots) { await fs.rm(root, { recursive: true, force: true }); }
});

interface ConverterConfig {
  input_directory: string;
  output_directory: string;
  mode?: OptimizeMode;
  unpack?: boolean;
}

async function fixture(inputMode: OptimizeMode = 'unpacked'): Promise<{ packsDir: string; outDir: string; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-optimize-'));
  const packsDir = path.join(root, 'packs');
  const outDir = path.join(root, 'out');

  roots.push(root);
  vi.stubEnv('BC_BDS_HOME', path.join(root, 'home'));

  for (const name of ['first to pack', 'second']) { await writePack(packsDir, name, inputMode); }

  return { root, packsDir, outDir };
}

async function writePack(root: string, name: string, mode: OptimizeMode): Promise<void> {
  const dir = path.join(root, name);

  await fs.mkdir(dir, { recursive: true });

  if (mode === 'brpak') {
    await fs.writeFile(path.join(dir, `${name}.brpak`), 'fixture-brpak-content');

    return;
  }

  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    header: mode === 'brarchive' ? { pack_optimization_version: '0.1.0' } : {},
  }));
  const file = mode === 'brarchive' ? '__brarchive/nested/data.brarchive' : 'recipes/data.json';

  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await fs.writeFile(path.join(dir, file), mode === 'brarchive' ? 'fixture-archive-content' : '{ "value": 42 }');
}

function converter(work: (config: ConverterConfig, stdout: PassThrough) => Promise<void>): void {
  spawn.mockImplementation((_executable: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });

    void (async (): Promise<void> => {
      const config = JSON.parse(await fs.readFile(args[0].slice('PackOptimizerConfigPath='.length), 'utf8')) as ConverterConfig;

      await work(config, child.stdout);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    })().catch((error) => { child.emit('error', error); });

    return child;
  });
}

async function size(dir: string): Promise<number> {
  let total = 0;

  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);

    total += entry.isDirectory() ? await size(file) : (await fs.stat(file)).size;
  }

  return total;
}

describe('PackOptimizer output modes', () => {
  it.each(['brpak', 'brarchive', 'unpacked'] as const)('selects modern %s output and measures packs without verbose records', async (mode) => {
    const options = await fixture();

    converter(async (config) => {
      expect(config.mode).toBe(mode);
      expect(config).not.toHaveProperty('unpack');

      for (const name of ['first to pack', 'second']) { await writePack(config.output_directory, name, mode); }
    });
    const result = await optimizePacks({ ...options, mode });

    expect(result.mode).toBe(mode);
    expect(result.unpacked).toBe(mode === 'unpacked');
    expect(result.packs.map(pack => pack.name)).toEqual(['first to pack', 'second']);

    for (const pack of result.packs) {
      expect(pack.mode).toBe(mode);
      expect(pack.statisticsAvailable).toBe(false);
      expect(pack.sizeBefore).toBe(await size(path.join(options.packsDir, pack.name)));
      expect(pack.sizeAfter).toBe(await size(path.join(options.outDir, pack.name)));
    }
  });

  it.each([
    ['1.26.70.23', 'brpak'],
    ['1.26.60.30', 'brarchive'],
  ] as const)('detects the default format of BDS %s', async (version, mode) => {
    const options = await fixture();

    resolveBds.mockResolvedValue({ dir: 'fixture-server', version, source: 'cache' });
    converter(async (config) => {
      expect(config).not.toHaveProperty('mode');
      expect(config).not.toHaveProperty('unpack');

      for (const name of ['first to pack', 'second']) { await writePack(config.output_directory, name, mode); }
    });

    expect((await optimizePacks(options)).mode).toBe(mode);
  });

  it.each(['brpak', 'brarchive', 'unpacked'] as const)('discovers BRPAK inputs without loose manifests for %s conversion', async (mode) => {
    const options = await fixture('brpak');

    converter(async (config) => {
      for (const name of ['first to pack', 'second']) { await writePack(config.output_directory, name, mode); }
    });

    expect((await optimizePacks({ ...options, mode })).packs).toHaveLength(2);
  });

  it.each([false, true])('uses only the legacy unpack field on an older BDS (alias: %s)', async (alias) => {
    const options = await fixture('brarchive');

    resolveBds.mockResolvedValue({ dir: 'fixture-server', version: '1.26.60.30', source: 'cache' });
    converter(async (config) => {
      expect(config.unpack).toBe(true);
      expect(config).not.toHaveProperty('mode');

      for (const name of ['first to pack', 'second']) { await writePack(config.output_directory, name, 'unpacked'); }
    });
    const result = await optimizePacks({ ...options, ...alias ? { unpack: true } : { mode: 'unpacked' as const } });

    expect(result.unpacked).toBe(true);
  });

  it('maps the unpack alias to the modern mode without sending the rejected legacy field', async () => {
    const options = await fixture('brarchive');

    converter(async (config) => {
      expect(config.mode).toBe('unpacked');
      expect(config).not.toHaveProperty('unpack');

      for (const name of ['first to pack', 'second']) { await writePack(config.output_directory, name, 'unpacked'); }
    });

    expect((await optimizePacks({ ...options, unpack: true })).unpacked).toBe(true);
  });

  it('rejects unsupported BRPAK output before clearing existing output', async () => {
    const options = await fixture();
    const sentinel = path.join(options.outDir, 'first to pack', 'keep.txt');

    await fs.mkdir(path.dirname(sentinel), { recursive: true });
    await fs.writeFile(sentinel, 'unchanged');
    resolveBds.mockResolvedValue({ dir: 'fixture-server', version: '1.26.60.30', source: 'cache' });

    await expect(optimizePacks({ ...options, mode: 'brpak' })).rejects.toThrow(/does not support brpak/);
    expect(spawn).not.toHaveBeenCalled();
    expect(await fs.readFile(sentinel, 'utf8')).toBe('unchanged');
  });

  it('keeps legacy protection against reoptimizing an already-converted pack', async () => {
    const options = await fixture('brarchive');

    resolveBds.mockResolvedValue({ dir: 'fixture-server', version: '1.26.60.30', source: 'cache' });

    await expect(optimizePacks(options)).rejects.toThrow(/already converted/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not accept a successful converter exit with a different output format', async () => {
    const options = await fixture();

    converter(async (config) => {
      for (const name of ['first to pack', 'second']) { await writePack(config.output_directory, name, 'brarchive'); }
    });

    await expect(optimizePacks({ ...options, mode: 'brpak' })).rejects.toThrow(/wrote brarchive.*expected brpak/);
  });

  it('does not mistake a retained manifest marker for an actual archive', async () => {
    const options = await fixture('brpak');

    converter(async (config) => {
      for (const name of ['first to pack', 'second']) {
        await writePack(config.output_directory, name, 'unpacked');
        await fs.writeFile(path.join(config.output_directory, name, 'manifest.json'),
          JSON.stringify({ header: { pack_optimization_version: '0.1.0' } }));
      }
    });

    await expect(optimizePacks({ ...options, mode: 'brarchive' })).rejects.toThrow(/wrote unpacked.*expected brarchive/);
  });

  it('rejects a successful converter exit that did not write the requested packs', async () => {
    const options = await fixture();

    converter(async () => {});

    await expect(optimizePacks({ ...options, mode: 'brpak' })).rejects.toThrow(/did not write a pack/);
  });

  it('reads modern BRPAK entry counts without counting its internal copies as loose files', async () => {
    const options = await fixture();

    converter(async (config, stdout) => {
      for (const name of ['first to pack', 'second']) {
        await writePack(config.output_directory, name, 'brpak');
        stdout.write(`wrote brpak ${path.join(config.output_directory, name, `${name}.brpak`)} with 7 entries\n`);
      }
    });

    expect((await optimizePacks({ ...options, mode: 'brpak' })).packs.map(pack => [pack.entries, pack.statisticsAvailable]))
      .toEqual([[7, true], [7, true]]);
  });

  it('requires an exact version for mode selection with an unidentified external binary', async () => {
    const options = await fixture();

    resolveBds.mockResolvedValue({ dir: 'fixture-server', version: 'unknown (BC_BDS_PATH)', source: 'env' });

    await expect(optimizePacks({ ...options, mode: 'brarchive' })).rejects.toThrow(/exact --bds-version/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects incompatible mode and unpack options before resolving a server', async () => {
    await expect(optimizePacks({ packsDir: 'unused', outDir: 'unused', mode: 'brpak', unpack: true }))
      .rejects.toThrow(/cannot be combined/);
    expect(resolveBds).not.toHaveBeenCalled();
  });
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
