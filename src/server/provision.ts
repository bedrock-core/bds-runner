import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { serverDir as serverDirFor, serverExecutable } from '../bds/paths';
import { type PropertyValue, renderServerProperties } from './properties';

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
  /** Stable directory name under .bds/server; the version is used when omitted. */
  instance?: string;
  levelName: string;
  port: number;
  watchdogHangMs: number;

  /** Advertise on the LAN, for a server that will be held open for someone to join. */
  lanVisible?: boolean;

  /** `server.properties` overrides from the config file. */
  properties?: Record<string, PropertyValue>;

  /** Delete the whole server tree first, forcing a fresh copy and a fresh world bootstrap. */
  fresh?: boolean;
  onProgress?: (message: string) => void;
}

export interface ProvisionResult {
  serverDir: string;
  worldDir: string;

  /** True when the world has not been generated yet, so it still needs the bootstrap boot. */
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
  const { cacheDir, version, instance, levelName, port, watchdogHangMs, lanVisible = false, properties, fresh = false } = options;
  const onProgress = options.onProgress ?? ((): void => {});

  const dir = serverDirFor(version, instance);
  const source = await fs.realpath(cacheDir);
  const relative = path.relative(dir, source);

  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error('The BDS source cache must be outside the executable instance.');
  }

  const marker = path.join(dir, '.bc-bds-source.json');
  const identity = instance === undefined
    ? undefined
    : {
        version,
        executable: await executableHash(path.join(source, serverExecutable())),
      };
  const previous = identity === undefined
    ? undefined
    : await fs.readFile(marker, 'utf8').then((text) => {
        try { return JSON.parse(text) as typeof identity; } catch { return undefined; }
      }, () => undefined);
  const changed = identity !== undefined && await exists(path.join(dir, serverExecutable()))
    && (previous?.version !== identity.version || previous?.executable !== identity.executable);

  if (fresh || changed) {
    onProgress(fresh ? 'removing the existing server tree (--fresh)' : `updating BDS instance ${instance} to ${version}`);
    await fs.rm(dir, { recursive: true, force: true });
  }

  if (!await exists(path.join(dir, serverExecutable()))) {
    onProgress(`copying Bedrock Dedicated Server ${version} into ${dir}`);
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.cp(cacheDir, dir, { recursive: true });

    if (process.platform !== 'win32') { await fs.chmod(path.join(dir, serverExecutable()), 0o755); }

    if (identity !== undefined) { await fs.writeFile(marker, `${JSON.stringify(identity)}\n`); }
  }

  await fs.writeFile(
    path.join(dir, 'server.properties'),
    renderServerProperties({ levelName, port, portV6: port + 1, watchdogHangMs, lanVisible, overrides: properties }),
  );

  await fs.mkdir(path.join(dir, 'config', 'default'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'config', 'default', 'permissions.json'),
    `${JSON.stringify({ allowed_modules: ALLOWED_MODULES }, null, 2)}\n`,
  );

  const worldDir = path.join(dir, 'worlds', levelName);

  // Keyed on the world rather than the tree: a bootstrap interrupted after the copy leaves a tree
  // with no world, and the next run must generate it rather than boot without Beta APIs.
  const created = !await exists(path.join(worldDir, 'level.dat'));

  return { serverDir: dir, worldDir, created };
}

async function executableHash(file: string): Promise<string> {
  const hash = createHash('sha256');

  for await (const chunk of createReadStream(file)) { hash.update(chunk); }

  return hash.digest('hex');
}

/**
 * Deletes the world's chunks so each run starts from unmodified terrain. `level.dat` is kept because
 * it carries the experiment toggles.
 */
export async function resetWorldChunks(worldDir: string): Promise<void> {
  await fs.rm(path.join(worldDir, 'db'), { recursive: true, force: true });
}

/**
 * Removes one generated world after its first boot did not reach a reusable state.
 *
 * The server copy and sibling worlds are deliberately kept: only this world's level.dat can make
 * a later run skip its bootstrap and therefore start without the experiments it needs.
 */
export async function discardWorld(worldDir: string): Promise<void> {
  await fs.rm(worldDir, { recursive: true, force: true });
}
