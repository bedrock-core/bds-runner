/**
 * Build metadata from [BDS-Versions](https://github.com/Bedrock-OSS/BDS-Versions): the download
 * URL, size and `sha1` of every build, and which build each channel currently points at. The index
 * hosts no binaries; every `download_url` points at minecraft.net.
 */
import type { Channel } from './download';

const RAW_ROOT = 'https://raw.githubusercontent.com/Bedrock-OSS/BDS-Versions/main';

/** How long to wait on the index before giving up. Small JSON; slow means unreachable. */
const INDEX_TIMEOUT_MS = 15_000;

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

/** The pin value that means "whatever the channel currently points at". */
export const LATEST = 'latest';

export interface BdsBuild {
  version: string;
  downloadUrl: string;

  /** From BDS-Versions; the download is verified against it. */
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
  let response: Response;

  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new Error(
      `could not reach BDS-Versions at ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

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

/** The build a channel currently points at. Throws when the index cannot be read. */
export async function currentVersion(channel: Channel, platform: string): Promise<string> {
  const index = await fetchIndex(platform);

  return channel === 'preview' ? index.preview : index.stable;
}

/** Resolves `latest` against the index; an exact version is returned as is. */
export async function resolveVersion(version: string, channel: Channel, platform: string): Promise<string> {
  return version === LATEST ? await currentVersion(channel, platform) : version;
}

/** Metadata for one exact build. A version the index does not know fails with the current build named. */
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

  const downloadUrl = String(raw.download_url ?? '');

  if (!downloadUrl.startsWith('https://')) {
    throw new Error(`BDS-Versions gave no usable download_url for ${version} (${channel}, ${platform})`);
  }

  return {
    version: String(raw.version ?? version),
    downloadUrl,
    sha1: String(raw.sha1 ?? ''),
    sizeInBytes: Number(raw.size_in_bytes ?? 0),
    date: String(raw.date ?? ''),
    releaseNotes: raw.release_notes ? String(raw.release_notes) : undefined,
  };
}
