import fs from 'node:fs/promises';
import path from 'node:path';
import { serverDir as serverDirFor, serverExecutable } from '../bds/paths';
import { renderServerProperties } from './properties';

/**
 * Modules the world's scripts are permitted to import.
 *
 * BDS ships a `config/default/permissions.json` that already allows `@minecraft/server-gametest`,
 * but writing our own makes the run independent of what a given build happens to default to, and
 * documents the surface the tests are allowed to touch.
 */
const ALLOWED_MODULES = [
  '@minecraft/server',
  '@minecraft/server-gametest',
  '@minecraft/server-ui',
  '@minecraft/debug-utilities',
];

export interface ProvisionOptions {
  cacheDir: string;
  version: string;
  levelName: string;
  port: number;
  watchdogHangMs: number;

  /** Delete the whole server tree first, forcing a fresh copy and a fresh world bootstrap. */
  fresh?: boolean;
  onProgress?: (message: string) => void;
}

export interface ProvisionResult {
  serverDir: string;
  worldDir: string;

  /** True when the tree was created by this call, so the world still needs bootstrapping. */
  created: boolean;
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false);
}

/**
 * Prepares the directory BDS runs in.
 *
 * The tree is a **copy** of the cache, kept between runs. Copying ~200 MB per run would dominate the
 * runtime, and symlinking is not an option on Windows without developer mode or elevation. Keeping
 * it also means the world bootstrap (which costs a full boot/stop cycle) happens once per BDS
 * version rather than once per run.
 *
 * The *world* is not preserved wholesale — see `resetWorldChunks`.
 */
export async function provisionServer(options: ProvisionOptions): Promise<ProvisionResult> {
  const { cacheDir, version, levelName, port, watchdogHangMs, fresh = false } = options;
  const onProgress = options.onProgress ?? ((): void => {});

  const dir = serverDirFor(version);

  if (fresh) {
    onProgress('removing the existing server tree (--fresh)');
    await fs.rm(dir, { recursive: true, force: true });
  }

  const created = !await exists(path.join(dir, serverExecutable()));

  if (created) {
    onProgress(`copying Bedrock Dedicated Server ${version} into ${dir}`);
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.cp(cacheDir, dir, { recursive: true });

    if (process.platform !== 'win32') { await fs.chmod(path.join(dir, serverExecutable()), 0o755); }
  }

  await fs.writeFile(
    path.join(dir, 'server.properties'),
    renderServerProperties({ levelName, port, portV6: port + 1, watchdogHangMs }),
  );

  await fs.mkdir(path.join(dir, 'config', 'default'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'config', 'default', 'permissions.json'),
    `${JSON.stringify({ allowed_modules: ALLOWED_MODULES }, null, 2)}\n`,
  );

  return { serverDir: dir, worldDir: path.join(dir, 'worlds', levelName), created };
}

/**
 * Throws away the world's chunks while keeping `level.dat`.
 *
 * Each run must start from unmodified terrain — a gametest that leaves blocks behind would
 * otherwise change what the next run sees, and a suite that only passes on a used world is worse
 * than useless. `level.dat` survives because it carries the experiment toggles that took a whole
 * boot cycle to set up.
 */
export async function resetWorldChunks(worldDir: string): Promise<void> {
  await fs.rm(path.join(worldDir, 'db'), { recursive: true, force: true });
}
