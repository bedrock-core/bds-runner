import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { type BdsBuild, fetchBuild } from './versions';

/**
 * Mojang's download host rejects the default `undici`/`curl` agent with a 403, so every request has
 * to identify itself. This is not cloaking — it is the identity the maintainers asked for.
 */
const USER_AGENT = '@bedrock-core/bds-runner (+github.com/bedrock-core/server)';

export type Channel = 'stable' | 'preview';

async function download(url: string, dest: string): Promise<void> {
  const headers = new Headers();

  headers.set('User-Agent', USER_AGENT);

  const response = await fetch(url, { headers });

  if (!response.ok || !response.body) {
    throw new Error(`GET ${url} returned ${response.status} ${response.statusText}`);
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(response.body, createWriteStream(dest));
}

async function sha1Of(file: string): Promise<string> {
  const hash = createHash('sha1');
  const handle = await fs.open(file, 'r');

  try {
    for await (const chunk of handle.createReadStream()) { hash.update(chunk as Buffer); }
  } finally {
    await handle.close();
  }

  return hash.digest('hex');
}

/**
 * Extracts a BDS zip.
 *
 * Deliberately does not trust entry names: a zip can name an entry `../../etc/passwd`, and while
 * Mojang's will not, the cost of checking is one comparison and the cost of not checking is
 * arbitrary file write.
 */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const resolvedDest = path.resolve(destDir);

  await new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) { return reject(err ?? new Error('could not open zip')); }

      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        const target = path.resolve(resolvedDest, entry.fileName);

        if (target !== resolvedDest && !target.startsWith(resolvedDest + path.sep)) {
          return reject(new Error(`zip entry escapes the destination directory: ${entry.fileName}`));
        }

        if (entry.fileName.endsWith('/')) {
          fs.mkdir(target, { recursive: true }).then(() => zip.readEntry(), reject);

          return;
        }

        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) { return reject(streamErr ?? new Error('could not read entry')); }

          fs.mkdir(path.dirname(target), { recursive: true })
            .then(() => pipeline(stream, createWriteStream(target)))
            .then(() => zip.readEntry())
            .catch(reject);
        });
      });

      zip.readEntry();
    });
  });
}

export interface FetchOptions {
  version: string;
  channel: Channel;
  platform: string;
  destDir: string;
  onProgress?: (message: string) => void;
}

/**
 * Downloads and extracts a BDS build into `destDir`.
 *
 * The URL and the expected `sha1` both come from BDS-Versions rather than being constructed here,
 * so a pinned version that does not exist fails while asking a community index — with the current
 * build named in the error — instead of as an opaque 404 from minecraft.net.
 *
 * Extraction goes to a sibling temp directory and is renamed into place at the end, so an
 * interrupted run cannot leave a half-extracted tree that later looks like a cache hit.
 */
export async function fetchBds(options: FetchOptions): Promise<BdsBuild> {
  const { version, channel, platform, destDir } = options;
  const onProgress = options.onProgress ?? ((): void => {});

  const build = await fetchBuild(version, channel, platform);
  const staging = `${destDir}.tmp-${process.pid}`;
  const zipPath = path.join(staging, `bedrock-server-${version}.zip`);

  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });

  try {
    const mb = (build.sizeInBytes / 1024 / 1024).toFixed(0);

    onProgress(`downloading ${build.downloadUrl} (${mb} MB, published ${build.date.slice(0, 10)})`);
    await download(build.downloadUrl, zipPath);

    const actual = await sha1Of(zipPath);

    if (build.sha1 && actual !== build.sha1) {
      throw new Error(
        `checksum mismatch for Bedrock Dedicated Server ${version}\n`
        + `  expected sha1 ${build.sha1} (from BDS-Versions)\n  actual   sha1 ${actual}\n`
        + 'Either the download was corrupted or Mojang re-rolled this build under the same version '
        + 'number. Do not run this binary until that is explained.',
      );
    }

    onProgress(build.sha1 ? `sha1 verified against BDS-Versions` : `sha1 ${actual} (upstream published none)`);

    const extracted = path.join(staging, 'extracted');

    onProgress('extracting');
    await extractZip(zipPath, extracted);

    if (process.platform !== 'win32') {
      await fs.chmod(path.join(extracted, 'bedrock_server'), 0o755);
    }

    await fs.rm(destDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(destDir), { recursive: true });
    await fs.rename(extracted, destDir);
    onProgress(`ready at ${destDir}`);

    return build;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
