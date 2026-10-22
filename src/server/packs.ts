import fs from 'node:fs/promises';
import path from 'node:path';
import { type PackDeployment, readDeploymentRecord, versionResourcePacks } from './pack-deployment';

export type PackVersion = number[] | string;

export interface PackInfo {

  /** The manifest **header** uuid — the only id `world_*_packs.json` matches against. */
  packId: string;
  version: PackVersion;
  name: string;
  dir: string;
  kind: 'behavior' | 'resource';

  /** Unique deployment directory derived from the input root and pack directory. */
  slug: string;
}

interface Manifest {
  header?: { uuid?: string; version?: PackVersion; name?: string };
  modules?: { type?: string }[];
}

/** Directory names that say "this is output" rather than naming the thing that was built. */
const GENERIC_ROOTS = new Set(['build', 'dist', 'out', 'export', 'packs', 'test', 'release']);

async function readManifest(packDir: string): Promise<Manifest> {
  const file = path.join(packDir, 'manifest.json');

  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Manifest;
  } catch (cause) {
    throw new Error(`could not read ${file}`, { cause });
  }
}

async function isDirectory(target: string): Promise<boolean> {
  return fs.stat(target).then(s => s.isDirectory(), () => false);
}

/**
 * Names the addon a `--packs` root belongs to.
 *
 * `packages/test-addon/build/test` is the addon `test-addon`, not `test`, so a root whose own name
 * only describes the build step is labelled by the first ancestor that says something.
 */
function rootLabel(root: string): string {
  let dir = root;

  for (let depth = 0; depth < 4; depth++) {
    const name = path.basename(dir);

    if (name && !GENERIC_ROOTS.has(name.toLowerCase())) { return name.replace(/[^\w.-]+/g, '_'); }

    dir = path.dirname(dir);
  }

  return path.basename(root).replace(/[^\w.-]+/g, '_') || 'pack';
}

async function discoverRoot(root: string, label: string): Promise<PackInfo[]> {
  const candidates: string[] = [];
  const hasManifest = async (directory: string): Promise<boolean> =>
    fs.stat(path.join(directory, 'manifest.json')).then(stat => stat.isFile(), () => false);

  if (await hasManifest(root)) {
    candidates.push(root);
  } else {
    const entries = await fs.readdir(root, { withFileTypes: true });

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const directory = path.join(root, entry.name);

      if (entry.isDirectory() && await hasManifest(directory)) { candidates.push(directory); }
    }
  }

  if (candidates.length === 0) {
    throw new Error(`no pack manifests found under ${root}; use a pack directory or a directory containing built packs`);
  }

  const packs: PackInfo[] = [];

  for (const dir of candidates) {
    const manifest = await readManifest(dir);
    const { uuid, version, name } = manifest.header ?? {};

    if (!uuid || !version) {
      throw new Error(`${path.join(dir, 'manifest.json')} has no header uuid/version`);
    }

    const types = new Set((manifest.modules ?? []).map(m => m.type));
    const kind = types.has('script') || types.has('data') ? 'behavior' : types.has('resources') ? 'resource' : undefined;

    if (!kind) {
      throw new Error(`${path.join(dir, 'manifest.json')} must declare a data, script or resources module`);
    }

    const directoryName = path.basename(dir);
    const suffix = dir === root || /^(?:BP|RP)$/i.test(directoryName)
      ? kind === 'behavior' ? 'bp' : 'rp'
      : directoryName.replace(/[^\w.-]+/g, '_');

    packs.push({
      packId: uuid,
      version,
      name: name ?? directoryName,
      dir,
      kind,
      slug: `${label}_${suffix}`,
    });
  }

  return packs;
}

/**
 * Discover a single manifest-bearing pack or the immediate pack directories in each build root.
 * Directory names carry no pack type meaning. Repeated roots combine packs in one test world.
 */
export async function discoverPacks(packsDirs: string | readonly string[]): Promise<PackInfo[]> {
  const roots = (typeof packsDirs === 'string' ? [packsDirs] : [...packsDirs]).map(dir => path.resolve(dir));

  if (roots.length === 0) { throw new Error('no --packs directory was given'); }

  const packs: PackInfo[] = [];
  const seenIds = new Set<string>();
  const usedSlugs = new Set<string>();

  for (const root of roots) {
    if (!await isDirectory(root)) { throw new Error(`--packs ${root} is not a directory`); }

    for (const pack of await discoverRoot(root, rootLabel(root))) {
      // Naming the same addon twice would deploy it twice and list it twice in
      // world_behavior_packs.json, which BDS rejects rather than ignores.
      if (seenIds.has(pack.packId)) { continue; }

      seenIds.add(pack.packId);

      // Distinct addons whose roots happen to share a label still need distinct folders.
      let slug = pack.slug;

      for (let n = 2; usedSlugs.has(slug); n++) { slug = `${pack.slug}_${n}`; }

      usedSlugs.add(slug);

      packs.push({ ...pack, slug });
    }
  }

  if (!packs.some(p => p.kind === 'behavior')) {
    throw new Error(
      `no behavior pack found under ${roots.join(', ')}. GameTests are registered from a behavior `
      + 'pack\'s script module, so there is nothing to run.',
    );
  }

  return packs;
}

/** Whether child is root itself or a descendant, using the current platform's path rules. */
function containsPath(root: string, child: string): boolean {
  const relative = path.relative(root, child);

  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function rejectLinkedDirectory(dir: string): Promise<void> {
  const stat = await fs.lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') { return undefined; }

    throw error;
  });

  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    throw new Error(`pack deployment requires a regular directory: ${dir}`);
  }
}

/**
 * Copies packs into the isolated server's development folders. World references still activate
 * the selected stack. World-local copies are removed because they can shadow the development
 * packs. Each managed destination is replaced completely so deleted files and packs cannot linger.
 * Source packs, the cached server build, and Minecraft client folders are never modified.
 */
export async function deployPacks(serverDir: string, worldDir: string, packs: PackInfo[]): Promise<PackDeployment> {
  const server = await fs.realpath(serverDir);
  const world = path.resolve(worldDir);
  const worlds = path.join(server, 'worlds');

  if (path.dirname(world) !== worlds) {
    throw new Error(`pack deployment world must be a direct child of ${worlds}: ${world}`);
  }

  await rejectLinkedDirectory(worlds);
  await rejectLinkedDirectory(world);

  const destinations = (['behavior', 'resource'] as const).map(kind => ({
    kind,
    development: path.join(server, `development_${kind}_packs`),
    world: path.join(world, `${kind}_packs`),
  }));
  const managed = destinations.flatMap(destination => [destination.development, destination.world]);

  // Validate the entire write set before removing any content. In particular, a build supplied
  // from inside a managed destination must not be deleted before it can be copied.
  for (const target of managed) {
    if (target === server || !containsPath(server, target)) {
      throw new Error(`pack deployment destination escapes the server: ${target}`);
    }

    await rejectLinkedDirectory(target);
  }

  for (const pack of packs) {
    if (!/^[\w.-]+$/.test(pack.slug) || pack.slug === '.' || pack.slug === '..') {
      throw new Error(`invalid pack deployment directory name: ${pack.slug}`);
    }

    const source = await fs.realpath(pack.dir);

    if (managed.some(target => containsPath(target, source) || containsPath(source, target))) {
      throw new Error(`pack source overlaps a managed deployment directory: ${pack.dir}`);
    }
  }

  const record = await readDeploymentRecord(server);
  const copies: (PackInfo & { sourceDir: string })[] = [];

  for (const destination of destinations) {
    await fs.rm(destination.world, { recursive: true, force: true });
    await fs.rm(destination.development, { recursive: true, force: true });
    await fs.mkdir(destination.development, { recursive: true });

    for (const pack of packs.filter(p => p.kind === destination.kind)) {
      const dir = path.join(destination.development, pack.slug);

      await fs.cp(pack.dir, dir, { recursive: true });
      copies.push({ ...pack, dir, sourceDir: pack.dir });
    }
  }

  return versionResourcePacks(copies, record);
}
