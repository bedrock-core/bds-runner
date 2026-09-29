import fs from 'node:fs/promises';
import path from 'node:path';

export interface PackInfo {

  /** The manifest **header** uuid — the only id `world_*_packs.json` matches against. */
  packId: string;
  version: number[];
  name: string;
  dir: string;
  kind: 'behavior' | 'resource';

  /** The directory this pack is deployed under, named after its addon so two `BP/` exports do not collide. */
  slug: string;
}

interface Manifest {
  header?: { uuid?: string; version?: number[]; name?: string };
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

  if (await isDirectory(path.join(root, 'BP'))) { candidates.push(path.join(root, 'BP')); }

  if (await isDirectory(path.join(root, 'RP'))) { candidates.push(path.join(root, 'RP')); }

  if (candidates.length === 0) { candidates.push(root); }

  const packs: PackInfo[] = [];

  for (const dir of candidates) {
    const manifest = await readManifest(dir);
    const { uuid, version, name } = manifest.header ?? {};

    if (!uuid || !version) {
      throw new Error(`${path.join(dir, 'manifest.json')} has no header uuid/version`);
    }

    // A pack carrying script or data modules is a behaviour pack; anything else is resources.
    const types = new Set((manifest.modules ?? []).map(m => m.type));
    const kind = types.has('script') || types.has('data') ? 'behavior' : 'resource';

    packs.push({
      packId: uuid,
      version,
      name: name ?? path.basename(dir),
      dir,
      kind,
      slug: `${label}_${kind === 'behavior' ? 'bp' : 'rp'}`,
    });
  }

  return packs;
}

/**
 * Finds the behaviour and resource packs under one or more build roots. A root is either the
 * `BP/` + `RP/` layout or a single pack. More than one root installs several addons into the same
 * world.
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
      `no behaviour pack found under ${roots.join(', ')}. GameTests are registered from a behaviour `
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
export async function deployPacks(serverDir: string, worldDir: string, packs: PackInfo[]): Promise<void> {
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

  for (const destination of destinations) {
    await fs.rm(destination.world, { recursive: true, force: true });
    await fs.rm(destination.development, { recursive: true, force: true });
    await fs.mkdir(destination.development, { recursive: true });

    for (const pack of packs.filter(p => p.kind === destination.kind)) {
      await fs.cp(pack.dir, path.join(destination.development, pack.slug), { recursive: true });
    }
  }
}
