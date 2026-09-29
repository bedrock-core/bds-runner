import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PackInfo, PackVersion } from './packs';

interface Manifest {
  header?: { uuid?: string; version?: unknown };
  modules?: { version?: unknown }[];
  dependencies?: { uuid?: string; module_name?: string; version?: unknown }[];
}

export interface DeployedPack extends PackInfo {
  sourceDir: string;
  sourceVersion: PackVersion;

  /** SHA-256 of the copied resource pack before deployment metadata is rewritten. */
  sourceHash?: string;
}

export interface PackDeployment {
  packs: DeployedPack[];
  resourceStackHash: string | null;
  recordFile: string;
}

interface DeploymentRecord {
  file: string;
  versionDigests: Record<string, string>;
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DIGEST = /^[a-f0-9]{64}$/;

function packVersion(value: unknown, location: string): PackVersion {
  if (typeof value === 'string' && VERSION.test(value)) { return value; }

  if (Array.isArray(value) && value.length === 3 && value.every(n => Number.isSafeInteger(n) && n >= 0)) {
    return [...value] as number[];
  }

  throw new Error(`invalid pack version in ${location}: ${JSON.stringify(value)}`);
}

function versionLabel(version: PackVersion): string {
  return typeof version === 'string' ? version : version.join('.');
}

function versionLike(original: PackVersion, version: number[]): PackVersion {
  return typeof original === 'string' ? version.join('.') : [...version];
}

/** Read before replacing any managed directory; a broken record must not discard collision history. */
export async function readDeploymentRecord(serverDir: string): Promise<DeploymentRecord> {
  const file = path.join(serverDir, 'pack-deployment.json');
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') { return undefined; }

    throw error;
  });

  if (!stat) { return { file, versionDigests: {} }; }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`pack deployment record must be a regular file: ${file}`);
  }

  const record = JSON.parse(await fs.readFile(file, 'utf8')) as {
    formatVersion?: unknown;
    versionDigests?: unknown;
  };
  const digests = record?.versionDigests;

  if (record?.formatVersion !== 1 || !digests || typeof digests !== 'object' || Array.isArray(digests)) {
    throw new Error(`invalid pack deployment record: ${file}`);
  }

  const entries = Object.entries(digests);

  for (const [version, digest] of entries) {
    if (!/^\d+\.\d+\.\d+$/.test(version) || version.split('.').some(n => Number(n) > 65_535)
      || typeof digest !== 'string' || !DIGEST.test(digest)) {
      throw new Error(`invalid version digest in pack deployment record: ${file}`);
    }
  }

  return { file, versionDigests: Object.fromEntries(entries) };
}

/** Length prefixes distinguish arbitrary file names and bytes without relying on delimiters. */
function hashField(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.alloc(8);

  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

async function hashResourcePack(dir: string): Promise<string> {
  const hash = createHash('sha256');

  hashField(hash, 'bc-bds-resource-pack-v1');

  const visit = async (current: string, relative: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });

    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

    for (const entry of entries) {
      const file = path.join(current, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await visit(file, name);
      } else if (entry.isFile()) {
        hashField(hash, name);
        hashField(hash, await fs.readFile(file));
      } else {
        throw new Error(`resource pack contains a linked or non-regular entry: ${file}`);
      }
    }
  };

  await visit(dir, '');

  return hash.digest('hex');
}

/**
 * Versions completed copies, so the fingerprint describes the build that BDS will serve even if
 * another build edits the source directories during deployment. UUIDs and source metadata stay
 * unchanged; only resource versions and references to those resource versions are rewritten.
 */
export async function versionResourcePacks(
  copies: (PackInfo & { sourceDir: string })[],
  record: DeploymentRecord,
): Promise<PackDeployment> {
  const manifests = new Map<string, Manifest>();
  const packs: DeployedPack[] = [];

  for (const copy of copies) {
    const file = path.join(copy.dir, 'manifest.json');

    // fs.cp can preserve symlinks. Never rewrite a manifest through a link to a source pack.
    if (!(await fs.lstat(copy.dir)).isDirectory() || !(await fs.lstat(file)).isFile()) {
      throw new Error(`deployed pack and manifest must be regular entries: ${file}`);
    }

    const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as Manifest;
    const sourceVersion = packVersion(manifest.header?.version, file);

    if (manifest.header?.uuid?.toLowerCase() !== copy.packId.toLowerCase()) {
      throw new Error(`pack UUID changed during deployment: ${copy.sourceDir}`);
    }

    manifests.set(copy.packId.toLowerCase(), manifest);
    packs.push({
      ...copy,
      sourceVersion,
      version: typeof sourceVersion === 'string' ? sourceVersion : [...sourceVersion],
      ...(copy.kind === 'resource' ? { sourceHash: await hashResourcePack(copy.dir) } : {}),
    });
  }

  const byId = new Map(packs.map(pack => [pack.packId.toLowerCase(), pack]));

  // Compare source versions before rewriting. Replacing every UUID reference blindly could make
  // a misconfigured dependency appear valid merely because both ends received a generated version.
  for (const pack of packs) {
    const manifest = manifests.get(pack.packId.toLowerCase())!;

    for (const dependency of manifest.dependencies ?? []) {
      if (dependency.module_name || !dependency.uuid) { continue; }

      const target = byId.get(dependency.uuid.toLowerCase());

      if (!target) { continue; }

      const expected = packVersion(dependency.version, `${pack.dir} dependency ${dependency.uuid}`);

      if (versionLabel(expected) !== versionLabel(target.sourceVersion)) {
        throw new Error(`${pack.name} requires ${target.packId} at ${versionLabel(expected)}, but the selected pack is ${versionLabel(target.sourceVersion)}`);
      }
    }
  }

  const resources = packs.filter(pack => pack.kind === 'resource').sort((a, b) => {
    const left = a.packId.toLowerCase();
    const right = b.packId.toLowerCase();

    return left < right ? -1 : left > right ? 1 : 0;
  });
  let resourceStackHash: string | null = null;
  let resourceVersion: number[] | null = null;

  if (resources.length) {
    const stack = createHash('sha256');

    hashField(stack, 'bc-bds-resource-stack-v1');

    for (const pack of resources) {
      hashField(stack, pack.packId.toLowerCase());
      hashField(stack, pack.sourceHash!);
    }

    const digest = stack.digest();

    resourceStackHash = digest.toString('hex');

    // A 48-bit deployment key encoded as three bounded integers works with both array and string
    // manifests. Full SHA-256 digests in the record detect any previously seen key collision.
    resourceVersion = [digest.readUInt16BE(0), digest.readUInt16BE(2), digest.readUInt16BE(4)];
    const key = resourceVersion.join('.');
    const known = record.versionDigests[key];

    if (known && known !== resourceStackHash) {
      throw new Error(`resource deployment version collision at ${key}: ${known} versus ${resourceStackHash}`);
    }

    if (resources.some(pack => versionLabel(pack.sourceVersion) === key)) {
      throw new Error(`resource deployment version ${key} matches a source version; refusing an ambiguous cache key`);
    }

    record.versionDigests[key] = resourceStackHash;

    for (const pack of resources) { pack.version = versionLike(pack.sourceVersion, resourceVersion); }
  }

  for (const pack of packs) {
    const manifest = manifests.get(pack.packId.toLowerCase())!;
    let changed = false;

    if (pack.kind === 'resource' && resourceVersion) {
      manifest.header!.version = pack.version;

      for (const module of manifest.modules ?? []) {
        module.version = versionLike(packVersion(module.version, `${pack.dir} module`), resourceVersion);
      }

      changed = true;
    }

    for (const dependency of manifest.dependencies ?? []) {
      if (dependency.module_name || !dependency.uuid || !resourceVersion) { continue; }

      const target = byId.get(dependency.uuid.toLowerCase());

      if (target?.kind !== 'resource') { continue; }

      dependency.version = versionLike(packVersion(dependency.version, `${pack.dir} dependency`), resourceVersion);
      changed = true;
    }

    if (changed) {
      const file = path.join(pack.dir, 'manifest.json');
      const mode = (await fs.stat(file)).mode;

      // Build tools can mark exported manifests read-only; fs.cp preserves that attribute. Only
      // the isolated copy is made writable so its deployment metadata can be updated.
      await fs.chmod(file, mode | 0o200);
      await fs.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }

  const temporary = path.join(path.dirname(record.file), `.pack-deployment-${randomUUID()}.tmp`);

  try {
    await fs.writeFile(temporary, `${JSON.stringify({
      formatVersion: 1,
      resourceStackHash,
      resourceVersion,
      packs,
      versionDigests: record.versionDigests,
    }, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporary, record.file);
  } finally {
    await fs.rm(temporary, { force: true });
  }

  return { packs, resourceStackHash, recordFile: record.file };
}
