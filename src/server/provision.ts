import fs from 'node:fs/promises';
import path from 'node:path';
import { serverDir as serverDirFor, serverExecutable } from '../bds/paths';
import { renderServerProperties } from './properties';

/** Modules the world's scripts may import. Written explicitly so the run does not depend on a build's default `permissions.json`. */
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

  /** Advertise on the LAN, for a server that will be held open for someone to join. */
  lanVisible?: boolean;

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
 * Prepares the directory BDS runs in: a copy of the cache, kept between runs so the copy and the
 * world bootstrap happen once per version. Symlinks need elevation on Windows, so it is a copy.
 * The world is reset separately; see `resetWorldChunks`.
 */
export async function provisionServer(options: ProvisionOptions): Promise<ProvisionResult> {
  const { cacheDir, version, levelName, port, watchdogHangMs, lanVisible = false, fresh = false } = options;
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
    renderServerProperties({ levelName, port, portV6: port + 1, watchdogHangMs, lanVisible }),
  );

  await fs.mkdir(path.join(dir, 'config', 'default'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'config', 'default', 'permissions.json'),
    `${JSON.stringify({ allowed_modules: ALLOWED_MODULES }, null, 2)}\n`,
  );

  return { serverDir: dir, worldDir: path.join(dir, 'worlds', levelName), created };
}

/**
 * Deletes the world's chunks so each run starts from unmodified terrain. `level.dat` is kept because
 * it carries the experiment toggles.
 */
export async function resetWorldChunks(worldDir: string): Promise<void> {
  await fs.rm(path.join(worldDir, 'db'), { recursive: true, force: true });
}
