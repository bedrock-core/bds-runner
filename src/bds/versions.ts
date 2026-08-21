/**
 * Build metadata from [BDS-Versions](https://github.com/Bedrock-OSS/BDS-Versions).
 *
 * Mojang publishes no version index — only "here is the current build" — so knowing that a pinned
 * version exists, or what a build's checksum should be, previously meant either trusting whatever
 * downloaded first or scraping. BDS-Versions is a community-maintained index that records every
 * build with its `sha1`, size and date.
 *
 * **It hosts no binaries.** Its `cdn_root` is minecraft.net and every `download_url` points there,
 * so this does not make the server downloadable on a network that blocks minecraft.net — see
 * `BC_BDS_PATH` and `--offline` for that. What it changes is trust: the checksum now comes from a
 * third party *before* the first download, rather than being recorded from whatever arrived.
 */
import type { Channel } from './download';

const RAW_ROOT = 'https://raw.githubusercontent.com/Bedrock-OSS/BDS-Versions/main';

/** BDS-Versions names platforms differently from Node, and keeps preview builds in their own tree. */
const PLATFORM_DIRS = new Map<string, string>([
  ['stable:win32-x64', 'windows'],
  ['stable:linux-x64', 'linux'],
  ['preview:win32-x64', 'windows_preview'],
  ['preview:linux-x64', 'linux_preview'],
]);

/** The key into `versions.json`, which tracks stable and preview under one platform entry. */
const INDEX_KEYS = new Map<string, string>([
  ['win32-x64', 'windows'],
  ['linux-x64', 'linux'],
]);

export interface BdsBuild {
  version: string;
  downloadUrl: string;

  /** Published by BDS-Versions, so integrity is checkable on the very first download. */
  sha1: string;
  sizeInBytes: number;
  date: string;
  releaseNotes?: string;
}

export interface PlatformIndex {
  stable: string;
  preview: string;
  versions: string[];
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });

  if (!response.ok) { throw new Error(`GET ${url} returned ${response.status} ${response.statusText}`); }

  return await response.json() as Record<string, unknown>;
}

function platformDir(channel: Channel, platform: string): string {
  const dir = PLATFORM_DIRS.get(`${channel}:${platform}`);

  if (!dir) { throw new Error(`BDS-Versions publishes no ${channel} builds for ${platform}`); }

  return dir;
}

/** The full index: which build is current per channel, and every build ever published. */
export async function fetchIndex(platform: string): Promise<PlatformIndex> {
  const key = INDEX_KEYS.get(platform);

  if (!key) { throw new Error(`no BDS-Versions index for ${platform}`); }

  const index = await fetchJson(`${RAW_ROOT}/versions.json`);
  const entry = index[key] as Record<string, unknown> | undefined;

  if (!entry) { throw new Error(`versions.json has no "${key}" entry`); }

  return {
    stable: String(entry.stable),
    preview: String(entry.preview),
    versions: (entry.versions as string[] | undefined) ?? [],
  };
}

/**
 * Metadata for one exact build.
 *
 * A missing file means the version does not exist upstream, which is worth saying precisely — a
 * typo in a pinned version otherwise surfaces as a bare 404 from a completely different host.
 */
export async function fetchBuild(version: string, channel: Channel, platform: string): Promise<BdsBuild> {
  const dir = platformDir(channel, platform);

  let raw: Record<string, unknown>;

  try {
    raw = await fetchJson(`${RAW_ROOT}/${dir}/${version}.json`);
  } catch (cause) {
    const index = await fetchIndex(platform).catch(() => null);
    const known = index?.versions.slice(-5).join(', ');
    const hint = index
      ? ` Current ${channel} build is ${channel === 'preview' ? index.preview : index.stable}`
      + (known ? `; most recent published: ${known}.` : '.')
      : '';

    throw new Error(`Bedrock Dedicated Server ${version} (${channel}, ${platform}) is not in BDS-Versions.${hint}`, { cause });
  }

  return {
    version: String(raw.version ?? version),
    downloadUrl: String(raw.download_url),
    sha1: String(raw.sha1 ?? ''),
    sizeInBytes: Number(raw.size_in_bytes ?? 0),
    date: String(raw.date ?? ''),
    releaseNotes: raw.release_notes ? String(raw.release_notes) : undefined,
  };
}

/** The build a channel currently points at, or `null` when the index cannot be read. */
export async function currentVersion(channel: Channel, platform: string): Promise<string | null> {
  try {
    const index = await fetchIndex(platform);

    return channel === 'preview' ? index.preview : index.stable;
  } catch {
    return null;
  }
}
