// Working out which server build a project wants, when it has not said.
//
// A pack's `min_engine_version` is the promise it makes to players: this is the oldest client that
// can load me. Running the tests on exactly that build tests the promise, and converting packs on
// it cannot emit an archive format newer than the promise allows. So the build a project gets by
// default is the newest one published in the line its own manifests name — `1.26.40` picks the
// newest `1.26.40.x` — and the result is written out as `bds-runner.json` so the choice stops
// being implicit the moment it is made.
//
// Nothing here is a fallback for a project that has a config file; it runs only when there is none.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Channel } from './download';
import { CONFIG_FILE } from './paths';
import { fetchIndex } from './versions';

/** Never walked: package installs, build output, the runner's own cache, and worlds. */
const SKIP = new Set([
  'node_modules', '.git', '.bds', '.regolith', '__brarchive',
  'build', 'dist', 'out', 'worlds', 'development_behavior_packs', 'development_resource_packs',
]);

/** Deep enough for `packs/BP/manifest.json` under a workspace folder, shallow enough to stay quick. */
const MAX_DEPTH = 5;

export interface DetectedPin extends Required<Pick<PinFields, 'version' | 'channel'>> {

  /** The `min_engine_version` the manifests agreed on, as `major.minor.patch`. */
  floor: string;

  /** How many pack manifests were read to get there. */
  manifests: number;
}

interface PinFields {
  version: string;
  channel: Channel;
}

/** `[1, 26, 40]` or `"1.26.40"`, as either may appear in a manifest. */
function asVersionParts(raw: unknown): number[] | undefined {
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' ? raw.split('.') : undefined;

  if (parts === undefined || parts.length < 3) { return undefined; }

  const numbers = parts.slice(0, 3).map(Number);

  return numbers.every(part => Number.isInteger(part) && part >= 0) ? numbers : undefined;
}

/** Component-wise, so `1.26.40.8` sorts above `1.26.40.10` is never the answer. */
function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;

    if (left !== right) { return left - right; }
  }

  return 0;
}

function parse(version: string): number[] {
  return version.split('.').map(Number).map(part => Number.isFinite(part) ? part : 0);
}

async function* walk(dir: string, depth: number): AsyncGenerator<string> {
  if (depth > MAX_DEPTH) { return; }

  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name) || entry.name.startsWith('.')) { continue; }

      yield* walk(path.join(dir, entry.name), depth + 1);
    } else if (entry.name === 'manifest.json') {
      yield path.join(dir, entry.name);
    }
  }
}

/**
 * The highest `min_engine_version` any pack under `root` declares.
 *
 * The highest rather than the lowest: a world where one pack needs a newer client than another is
 * a world where the newer one decides, because every pack has to load for the addon to work.
 */
export async function detectFloor(root: string): Promise<{ floor: number[]; manifests: number } | undefined> {
  let highest: number[] | undefined;
  let manifests = 0;

  for await (const file of walk(root, 0)) {
    const raw = await fs.readFile(file, 'utf-8').catch(() => undefined);

    if (raw === undefined) { continue; }

    let header: { min_engine_version?: unknown } | undefined;

    try {
      header = (JSON.parse(raw) as { header?: { min_engine_version?: unknown } }).header;
    } catch {
      // A manifest the build has not resolved yet, or one with a comment in it. Not our business.
      continue;
    }

    const parts = asVersionParts(header?.min_engine_version);

    if (parts === undefined) { continue; }

    manifests++;

    if (highest === undefined || compare(parts, highest) > 0) { highest = parts; }
  }

  return highest === undefined ? undefined : { floor: highest, manifests };
}

/**
 * The newest published build in the line the project's manifests name.
 *
 * Stable is preferred; a line that only ever shipped as preview — every `x.y.z` between two stable
 * releases — falls back to it, because a preview build of the named version is still closer to the
 * promise than the newest build of some other version.
 *
 * @returns nothing when no manifest declares a version, when the index is unreachable, or when the
 * named line was never published — the caller then falls back to `latest`.
 */
export async function detectPin(root: string, platform: string): Promise<DetectedPin | undefined> {
  const detected = await detectFloor(root);

  if (detected === undefined) { return undefined; }

  const floor = detected.floor.join('.');
  const index = await fetchIndex(platform).catch(() => undefined);

  if (index === undefined) { return undefined; }

  const newestIn = (versions: readonly string[]): string | undefined => versions
    .filter(version => version.startsWith(`${floor}.`) || version === floor)
    .sort((a, b) => compare(parse(a), parse(b)))
    .at(-1);

  const stable = newestIn(index.versions);

  if (stable !== undefined) {
    return { version: stable, channel: 'stable', floor, manifests: detected.manifests };
  }

  const preview = newestIn(index.previewVersions);

  return preview === undefined
    ? undefined
    : { version: preview, channel: 'preview', floor, manifests: detected.manifests };
}

/**
 * Writes the detected pin as the project's config file.
 *
 * @returns the path written, or nothing if a config file appeared in the meantime — two commands
 * started together must not both claim to have created it.
 */
export async function writeDetectedConfig(root: string, pin: DetectedPin): Promise<string | undefined> {
  const file = path.join(root, CONFIG_FILE);

  const body = `${JSON.stringify({
    $schema: `./.bds/schema/${CONFIG_FILE}`,
    version: pin.version,
    channel: pin.channel,
  }, null, '\t')}\n`;

  try {
    await fs.writeFile(file, body, { flag: 'wx' });
  } catch {
    return undefined;
  }

  return file;
}
