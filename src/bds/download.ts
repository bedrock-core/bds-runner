import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { type BdsBuild, fetchBuild } from './versions';

/**
 * Keep this a bare `name/version` token. The download host resets the connection for any
 * `User-Agent` that carries a bot-style comment such as `(+https://example.com/bot)`.
 *
 * The version is read from this package's own manifest so it cannot drift from the release.
 */
const USER_AGENT = `bedrock-core-bds-runner/${packageVersion()}`;

function packageVersion(): string {
  try {
    const manifest = createRequire(import.meta.url)('../../package.json') as { version?: string };

    return manifest.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Time allowed to get response headers back. The body then streams under `STALL_MS`. */
const CONNECT_TIMEOUT_MS = 30_000;

/** Time allowed between two chunks of the body, so a dead connection fails without capping a slow one. */
const STALL_MS = 60_000;

const ATTEMPTS = 3;

export type Channel = 'stable' | 'preview';

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Wraps the body so a connection that goes quiet fails instead of hanging the whole run. */
async function* withStallTimeout(
  body: ReadableStream<Uint8Array>,
  onChunk: (bytes: number) => void,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();

  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`download stalled for ${STALL_MS / 1000}s`)), STALL_MS);
      });

      let result: ReadableStreamReadResult<Uint8Array>;

      try {
        result = await Promise.race([reader.read(), stalled]);
      } finally {
        clearTimeout(timer);
      }

      if (result.done) { return; }

      if (result.value) {
        onChunk(result.value.byteLength);
        yield result.value;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function downloadOnce(
  url: string,
  dest: string,
  expectedBytes: number,
  onProgress: (message: string) => void,
): Promise<void> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'accept': 'application/zip,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  });

  if (!response.ok || !response.body) {
    throw new Error(`GET ${url} returned ${response.status} ${response.statusText}`);
  }

  const total = Number(response.headers.get('content-length') ?? expectedBytes);
  let received = 0;
  let lastReport = 0;

  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rm(dest, { force: true });

  await pipeline(
    withStallTimeout(response.body, (bytes) => {
      received += bytes;

      // Report every 10%, so a long download shows life without flooding a CI log.
      if (total > 0 && received - lastReport >= total / 10) {
        lastReport = received;
        onProgress(`  ${Math.round((received / total) * 100)}%`);
      }
    }),
    createWriteStream(dest),
  );

  // Catch a truncated body here rather than as an unreadable zip later.
  if (expectedBytes > 0 && received !== expectedBytes) {
    throw new Error(`expected ${expectedBytes} bytes, received ${received}`);
  }
}

/** Retries transport failures; a 4xx is answered the same way every time, so it is not retried. */
async function download(
  url: string,
  dest: string,
  expectedBytes: number,
  onProgress: (message: string) => void,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await downloadOnce(url, dest, expectedBytes, onProgress);

      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (attempt >= ATTEMPTS || /returned 4\d\d /.test(message)) {
        throw new Error(`could not download ${url}: ${message}`, { cause: error });
      }

      onProgress(`  attempt ${attempt} failed (${message}); retrying`);
      await delay(attempt * 2_000);
    }
  }
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

/** Extracts a BDS zip, rejecting any entry whose path escapes `destDir`. */
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
  /** An exact build; `latest` must already have been resolved against the index. */
  version: string;
  channel: Channel;
  platform: string;
  destDir: string;
  onProgress?: (message: string) => void;
}

/**
 * Downloads and extracts a build into `destDir`, verifying it against the `sha1` from BDS-Versions.
 *
 * Extraction goes to a sibling temp directory that is renamed into place at the end, so an
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
    await download(build.downloadUrl, zipPath, build.sizeInBytes, onProgress);

    const actual = await sha1Of(zipPath);

    if (build.sha1 && actual !== build.sha1) {
      throw new Error(
        `checksum mismatch for Bedrock Dedicated Server ${version}\n`
        + `  expected sha1 ${build.sha1} (from BDS-Versions)\n  actual   sha1 ${actual}\n`
        + 'Either the download was corrupted or Mojang re-rolled this build under the same version '
        + 'number. Do not run this binary until that is explained.',
      );
    }

    onProgress(build.sha1 ? 'sha1 verified against BDS-Versions' : `sha1 ${actual} (upstream published none)`);

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
