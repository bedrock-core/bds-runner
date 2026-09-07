import fs from 'node:fs/promises';
import path from 'node:path';
import nbt from 'prismarine-nbt';

/**
 * Enabling Beta APIs on a Bedrock Dedicated Server.
 *
 * There is no `server.properties` key and no command-line flag for experiments — they live only in
 * the world's `level.dat`, as a root `experiments` compound. `@minecraft/server-gametest` is a beta
 * module, so without this the `/gametest` command does not exist and the pack fails to load.
 *
 * `level.dat` is an 8-byte header (`uint32 storageVersion`, `uint32 bodyLength`) followed by
 * little-endian NBT — verified on BDS 1.26.43.1, where a freshly generated world reads
 * `0a000000 b90b0000` for a 3001-byte body.
 *
 * A generated world already has an `experiments` compound holding `experiments_ever_used` and
 * `saved_with_toggled_experiments` at 0; the toggle is added to it.
 */

/** The NBT key for the "Beta APIs" toggle. The game abbreviates it to `gtst` in its boot log. */
const BETA_APIS_KEY = 'gametest';

/** `Generator`: 2 selects a flat world — a predictable ground plane for gametest plots. */
const GENERATOR_FLAT = 2;

export interface BootstrapResult {
  changed: boolean;
  experiments: string[];
}

interface NbtCompound {
  type: string;
  value: Record<string, { type: string; value: unknown }>;
}

async function readLevelDat(file: string): Promise<{ storageVersion: number; root: NbtCompound }> {
  const buffer = await fs.readFile(file);

  if (buffer.length < 9) { throw new Error(`${file} is too small to be a level.dat`); }

  const storageVersion = buffer.readUInt32LE(0);
  const declaredLength = buffer.readUInt32LE(4);
  const body = buffer.subarray(8);

  if (declaredLength !== body.length) {
    throw new Error(
      `${file} declares a ${declaredLength}-byte body but has ${body.length}. `
      + 'Refusing to rewrite a level.dat we do not understand.',
    );
  }

  const { parsed } = await nbt.parse(body, 'little');

  return { storageVersion, root: parsed as unknown as NbtCompound };
}

async function writeLevelDat(file: string, storageVersion: number, root: NbtCompound): Promise<void> {
  const body = nbt.writeUncompressed(root as never, 'little');
  const header = Buffer.alloc(8);

  header.writeUInt32LE(storageVersion, 0);

  // The length field must describe the body we are about to write, not the one we read.
  header.writeUInt32LE(body.length, 4);

  await fs.writeFile(file, Buffer.concat([header, body]));
}

function activeExperiments(root: NbtCompound): string[] {
  const experiments = root.value.experiments as NbtCompound | undefined;

  if (!experiments) { return []; }

  return Object.entries(experiments.value)
    .filter(([, entry]) => entry.value === 1)
    .map(([key]) => key);
}

/**
 * Turns Beta APIs and a flat generator on in a world BDS has already generated. Returns
 * `changed: false` when they are already set.
 *
 * The write is read back to verify it; a failed write otherwise surfaces much later as
 * `Unknown command: gametest`.
 */
export async function enableBetaApis(worldDir: string): Promise<BootstrapResult> {
  const file = path.join(worldDir, 'level.dat');
  const { storageVersion, root } = await readLevelDat(file);

  const experiments = (root.value.experiments as NbtCompound | undefined) ?? { type: 'compound', value: {} };
  const before = JSON.stringify(experiments.value);

  experiments.value[BETA_APIS_KEY] = { type: 'byte', value: 1 };
  experiments.value.experiments_ever_used = { type: 'byte', value: 1 };
  experiments.value.saved_with_toggled_experiments = { type: 'byte', value: 1 };
  root.value.experiments = experiments;

  const generatorWas = (root.value.Generator as { value: number } | undefined)?.value;

  root.value.Generator = { type: 'int', value: GENERATOR_FLAT };

  const changed = before !== JSON.stringify(experiments.value) || generatorWas !== GENERATOR_FLAT;

  if (!changed) { return { changed: false, experiments: activeExperiments(root) }; }

  await writeLevelDat(file, storageVersion, root);

  const { root: verified } = await readLevelDat(file);
  const active = activeExperiments(verified);

  if (!active.includes(BETA_APIS_KEY)) {
    throw new Error(
      `wrote ${file} but experiments.${BETA_APIS_KEY} did not stick, so Beta APIs are still off.\n`
      + 'Without them the /gametest command does not exist and the pack will not load. Workaround: '
      + 'create a flat creative world in the Minecraft client with "Beta APIs" enabled, then copy '
      + `its level.dat over ${file}.`,
    );
  }

  return { changed: true, experiments: active };
}

interface PackReference {
  packId: string;
  version: number[];
}

/**
 * Points the world at the packs to load.
 *
 * BDS reads `world_behavior_packs.json` / `world_resource_packs.json` from the world directory and
 * matches each `pack_id` against the packs it can see, preferring the world-local
 * `behavior_packs/` and `resource_packs/` folders. The ids must be the **header** uuids from each
 * manifest — a module uuid silently matches nothing.
 */
export async function writeWorldPackReferences(
  worldDir: string,
  behavior: PackReference[],
  resource: PackReference[],
): Promise<void> {
  const render = (refs: PackReference[]): string => `${JSON.stringify(refs.map(r => ({ pack_id: r.packId, version: r.version })), null, 2)}\n`;

  await fs.writeFile(path.join(worldDir, 'world_behavior_packs.json'), render(behavior));
  await fs.writeFile(path.join(worldDir, 'world_resource_packs.json'), render(resource));
}
