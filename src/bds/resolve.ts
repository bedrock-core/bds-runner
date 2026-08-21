import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchBds } from './download';
import { cacheDir, pinnedVersion, platformKey, serverExecutable } from './paths';

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
 * Serialises concurrent resolves against one cache directory.
 *
 * Two `test:mc` invocations extracting the same 200 MB tree into the same path would interleave and
 * leave a corrupt server. An exclusive-create lock file is enough; a stale one (a killed process
 * never cleans up) is broken after ten minutes rather than deadlocking the run forever.
 */
async function withLock<T>(lockPath: string, work: () => Promise<T>): Promise<T> {
  const staleAfterMs = 10 * 60_000;

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

  try {
    return await work();
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}

export interface ResolveOptions {
  onProgress?: (message: string) => void;

  /** Fail instead of downloading. Used by callers that must not touch the network. */
  offline?: boolean;
}

/**
 * Finds a Bedrock Dedicated Server to run, in order of decreasing authority:
 *
 * 1. `BC_BDS_PATH` — a server the developer manages. Never validated beyond "the binary is there",
 *    because second-guessing an explicit override helps nobody.
 * 2. the extracted cache for the pinned version;
 * 3. a fresh download.
 *
 * The override matters more than it looks: `www.minecraft.net` is unreachable from some networks
 * (it resolves but never connects), so on those machines the cache has to be primed by hand and
 * downloading is a CI-only path.
 */
export async function resolveBds(options: ResolveOptions = {}): Promise<ResolvedBds> {
  const { onProgress = (): void => {}, offline = false } = options;
  const { version, channel } = pinnedVersion();
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

  const dir = cacheDir(version, platform);

  if (await exists(path.join(dir, serverExecutable()))) {
    return { dir, version, source: 'cache' };
  }

  if (offline) {
    throw new Error(
      `Bedrock Dedicated Server ${version} is not in the cache at ${dir} and downloading is disabled. `
      + 'Run `yarn bds:fetch`, or set BC_BDS_PATH to a server you already have.',
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
