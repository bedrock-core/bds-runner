import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchBds } from './download';
import { writeConfigSchema } from '../server/schema';
import { detectPin, writeDetectedConfig } from './detect';
import {
  cacheDir,
  CONFIG_FILE,
  findConfig,
  pinnedVersion,
  platformKey,
  projectRoot,
  schemaFile,
  serverExecutable,
} from './paths';
import { LATEST, resolveVersion } from './versions';

export interface ResolvedBds {
  dir: string;
  version: string;
  source: 'env' | 'cache' | 'download';
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);

    return true;
  } catch {
    return false;
  }
}

/**
 * Serialises concurrent resolves against one cache directory, so two runs cannot interleave their
 * extraction. The holder touches the lock every minute; one not touched for ten minutes is treated
 * as abandoned, so a slow download is never mistaken for a dead process.
 */
async function withLock<T>(lockPath: string, work: () => Promise<T>): Promise<T> {
  const staleAfterMs = 10 * 60_000;
  const touchEveryMs = 60_000;

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx');

      await handle.close();
      break;
    } catch {
      const age = await fs.stat(lockPath).then(s => Date.now() - s.mtimeMs, () => Infinity);

      if (age > staleAfterMs) {
        await fs.rm(lockPath, { force: true });
        continue;
      }

      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  }

  const heartbeat = setInterval(() => {
    const now = new Date();

    fs.utimes(lockPath, now, now).catch(() => {});
  }, touchEveryMs);

  heartbeat.unref();

  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
    await fs.rm(lockPath, { force: true });
  }
}

export interface ResolveOptions {
  onProgress?: (message: string) => void;

  /** Fail instead of downloading. Used by callers that must not touch the network. */
  offline?: boolean;

  /** Run against a build other than the one in the config file, just for this run. */
  version?: string;
  channel?: 'stable' | 'preview';
  configPath?: string;
}

/**
 * Finds a server to run: `BC_BDS_PATH`, else the cache, else a download. Also regenerates the
 * config file's JSON Schema from that server's `server.properties`.
 *
 * `latest` is resolved against BDS-Versions before the cache is consulted, so the cache answers for
 * the build that is current now.
 */
export async function resolveBds(options: ResolveOptions = {}): Promise<ResolvedBds> {
  const resolved = await locateBds(options);

  await writeConfigSchema(resolved.dir, resolved.version, schemaFile());

  return resolved;
}

/**
 * Gives a project that has never chosen a build the one its own packs ask for, and writes the
 * choice down. Runs only when nothing else has already made it: no flag, no config file, no
 * `BC_BDS_PATH`, and a network to look the build up on.
 */
async function adoptDetectedPin(onProgress: (message: string) => void): Promise<void> {
  const root = projectRoot();
  const pin = await detectPin(root, platformKey()).catch(() => undefined);

  if (pin === undefined) {
    onProgress(`no ${CONFIG_FILE} and no min_engine_version to read — taking the newest stable build`);

    return;
  }

  const written = await writeDetectedConfig(root, pin);

  onProgress(
    `no ${CONFIG_FILE}: ${pin.manifests} manifest(s) declare min_engine_version ${pin.floor}`,
  );
  onProgress(written === undefined
    ? `using ${pin.version} (${pin.channel}), the newest ${pin.floor} build`
    : `pinned ${pin.version} (${pin.channel}) in ${path.relative(process.cwd(), written) || CONFIG_FILE}`);
}

async function locateBds(options: ResolveOptions): Promise<ResolvedBds> {
  const { onProgress = (): void => {}, offline = false } = options;

  if (
    !process.env.BC_BDS_PATH
    && options.version === undefined
    && options.configPath === undefined
    && !offline
    && findConfig() === undefined
  ) {
    await adoptDetectedPin(onProgress);
  }

  const pinned = pinnedVersion({ version: options.version, channel: options.channel, configPath: options.configPath });
  const { channel } = pinned;
  const platform = platformKey();

  if (process.env.BC_BDS_PATH) {
    const dir = path.resolve(process.env.BC_BDS_PATH);
    const exe = path.join(dir, serverExecutable());

    if (!await exists(exe)) {
      throw new Error(
        `BC_BDS_PATH is set to ${dir} but ${serverExecutable()} is not there. `
        + 'Point it at the directory containing the server binary.',
      );
    }

    onProgress(`using BC_BDS_PATH ${dir}`);

    return { dir, version: 'unknown (BC_BDS_PATH)', source: 'env' };
  }

  if (pinned.version === LATEST && offline) {
    throw new Error(
      'the pinned version is "latest", which has to be looked up in BDS-Versions, and downloading '
      + 'is disabled. Pass --bds-version, set an exact "version" in bds-runner.json, or set '
      + 'BC_BDS_PATH to a server you already have.',
    );
  }

  const version = await resolveVersion(pinned.version, channel, platform);

  if (pinned.version === LATEST) { onProgress(`latest ${channel} build is ${version}`); }

  const dir = cacheDir(version, platform);

  if (await exists(path.join(dir, serverExecutable()))) {
    return { dir, version, source: 'cache' };
  }

  if (offline) {
    throw new Error(
      `Bedrock Dedicated Server ${version} is not in the cache at ${dir} and downloading is disabled. `
      + 'Run `bc-bds fetch`, or set BC_BDS_PATH to a server you already have.',
    );
  }

  return withLock(`${dir}.lock`, async () => {
    // Another process may have won the race while we waited for the lock.
    if (await exists(path.join(dir, serverExecutable()))) {
      return { dir, version, source: 'cache' as const };
    }

    await fetchBds({ version, channel, platform, destDir: dir, onProgress });

    return { dir, version, source: 'download' as const };
  });
}
