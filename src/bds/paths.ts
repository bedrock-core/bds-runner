import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** `packages/bds-runner` — the package root, wherever it has been installed or copied to. */
export const packageRoot = path.resolve(here, '..', '..');

/**
 * The monorepo root. Everything the runner writes lives under it in one gitignored directory, so a
 * developer can reclaim ~1 GB by deleting a single folder and knows exactly what to delete.
 */
export const repoRoot = path.resolve(packageRoot, '..', '..');

/** `<repo>/.bds` unless `BC_BDS_HOME` says otherwise (CI caches, or a drive with room). */
export function bdsHome(): string {
  return process.env.BC_BDS_HOME
    ? path.resolve(process.env.BC_BDS_HOME)
    : path.join(repoRoot, '.bds');
}

/** Extracted, pristine BDS trees, one per version+platform. Never run from here — see `serverDir`. */
export function cacheDir(version: string, platform = platformKey()): string {
  return path.join(bdsHome(), 'cache', version, platform);
}

/**
 * The tree BDS actually runs in: a copy of the cache, kept across runs so the ~200 MB copy and the
 * world bootstrap happen once per version rather than once per run.
 */
export function serverDir(version: string): string {
  return path.join(bdsHome(), 'server', version);
}

export function logsDir(): string {
  return path.join(bdsHome(), 'logs');
}

export function platformKey(): 'win32-x64' | 'linux-x64' {
  if (process.platform === 'win32') { return 'win32-x64'; }

  if (process.platform === 'linux') { return 'linux-x64'; }

  throw new Error(
    `Bedrock Dedicated Server is published for Windows and Linux only; this is ${process.platform}. `
    + 'Run the in-game tests on one of those, or point BC_BDS_PATH at a server you manage yourself.',
  );
}

export function serverExecutable(): string {
  return process.platform === 'win32' ? 'bedrock_server.exe' : 'bedrock_server';
}

export interface PinnedVersion {
  version: string;
  channel: 'stable' | 'preview';
  note?: string;
}

/**
 * The pinned build. `BC_BDS_VERSION` overrides it for a one-off check against another engine.
 *
 * No checksum is recorded here: BDS-Versions publishes the `sha1` for every build, so the expected
 * value is fetched alongside the download URL rather than being copied into this repo and going
 * stale.
 */
export function pinnedVersion(): PinnedVersion {
  const pinned = JSON.parse(
    readFileSync(path.join(packageRoot, 'bds-version.json'), 'utf8'),
  ) as PinnedVersion;

  return process.env.BC_BDS_VERSION
    ? { ...pinned, version: process.env.BC_BDS_VERSION }
    : pinned;
}
