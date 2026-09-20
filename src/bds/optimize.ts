// Pack optimization: the server's own converter, driven as a build step.
//
// `bedrock_server PackOptimizerConfigPath=<config>` reads a directory whose subdirectories are
// each one pack, minifies their JSON, packs each folder into a `.brarchive` under `__brarchive/`,
// stamps `pack_optimization_version` into the manifest, and exits without ever serving. `unpack`
// runs it backwards, expanding the archives into loose files again.
//
// A converted pack requires a 1.26.40 or newer client. The converter does not raise
// `min_engine_version`, so nothing in the pack tells an older player why it failed to load.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { bdsHome, serverExecutable } from './paths';
import { resolveBds } from './resolve';

/** The converter reports this when it could not process the packs. */
const RESOURCE_PROCESSING_ERROR = 7;

/** The argument was ignored and the build went on to serve instead — see `Platform`, below. */
const SERVING_RE = /\bServer started\b/;

/** A conversion that has not finished by now is not going to; the converter is otherwise seconds. */
const DEFAULT_WALL_MS = 10 * 60_000;

export interface OptimizeOptions {

  /**
   * Directory whose subdirectories are each one pack. Regolith's `build/` is already this shape:
   * one folder per pack, each with its own manifest.
   */
  packsDir: string;

  /** Where the converted packs are written. Created as needed, and never overlapping `packsDir`. */
  outDir: string;

  /** Expand an already-converted tree back into loose files instead of converting one. */
  unpack?: boolean;

  /** Echo the converter's own per-file lines. The statistics are collected either way. */
  echo?: boolean;

  /** Wall-clock limit for the conversion. */
  wallMs?: number;

  onProgress?: (message: string) => void;

  offline?: boolean;

  /** Run against a build other than the one in the config file, just for this conversion. */
  bdsVersion?: string;
  bdsChannel?: 'stable' | 'preview';
  configPath?: string;
}

export interface OptimizedPack {
  name: string;

  /** Files written into an archive. */
  entries: number;

  /**
   * Entries that name a file but carry none of its bytes. The engine learns the directory's
   * contents from the archive and still reads the file itself from disk — how `.lang` is handled.
   */
  stubs: number;

  /**
   * Bytes of content the archives hold, before and after, as the converter reports them.
   *
   * Stub entries are excluded: nothing about those files moved, so counting their size as
   * "before" would credit the conversion with a saving it did not make.
   */
  bytesBefore: number;
  bytesAfter: number;

  /** Files copied beside the archives rather than into them: the manifest, the pack icon, every stub. */
  copied: number;

  /** What the pack weighs on disk either side of the conversion — the number that ships. */
  sizeBefore: number;
  sizeAfter: number;
}

export interface OptimizeResult {
  packs: OptimizedPack[];
  bdsVersion: string;
  outDir: string;
  durationMs: number;

  /** `unpack`, rather than a conversion. */
  unpacked: boolean;
}

async function isDirectory(target: string): Promise<boolean> {
  return fs.stat(target).then(stat => stat.isDirectory(), () => false);
}

/** Total bytes of every file under `dir`, or 0 if it is not there. */
async function dirSize(dir: string): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  let total = 0;

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    total += entry.isDirectory()
      ? await dirSize(full)
      : await fs.stat(full).then(stat => stat.size, () => 0);
  }

  return total;
}

/** `a` contains `b`, or is `b`. Compared case-insensitively, because Windows paths are. */
function contains(a: string, b: string): boolean {
  const rel = path.relative(a, b).toLowerCase();

  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The pack directories the converter will read: every subdirectory holding a manifest. */
async function findPacks(packsDir: string): Promise<string[]> {
  const entries = await fs.readdir(packsDir, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) { continue; }

    const manifest = path.join(packsDir, entry.name, 'manifest.json');

    if (await fs.access(manifest).then(() => true, () => false)) { found.push(entry.name); }
  }

  return found.sort();
}

/** Whether a pack has already been through the converter. */
async function isOptimized(packDir: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(packDir, 'manifest.json'), 'utf-8');
    const manifest = JSON.parse(raw) as { header?: { pack_optimization_version?: unknown } };

    return manifest.header?.pack_optimization_version !== undefined;
  } catch {
    return false;
  }
}

/**
 * Collects the converter's output into per-pack statistics.
 *
 * Its lines are stable enough to read, and the only place the byte counts exist — nothing is
 * written that records what a file weighed before.
 */
class Tally {
  readonly packs: OptimizedPack[] = [];
  #current: OptimizedPack | undefined;

  constructor(private readonly outDir: string) {}

  #ensure(name: string): OptimizedPack {
    const existing = this.packs.find(pack => pack.name === name);

    if (existing) { return existing; }

    const pack: OptimizedPack = {
      name,
      entries: 0,
      stubs: 0,
      bytesBefore: 0,
      bytesAfter: 0,
      copied: 0,
      sizeBefore: 0,
      sizeAfter: 0,
    };

    this.packs.push(pack);

    return pack;
  }

  line(text: string): void {
    // `bake pack <src> to <dest>, archive root <dest>/<pack>/__brarchive` — the archive root is
    // read rather than the paths either side of " to ", which a directory name could contain.
    const baked = /, archive root (.+)$/.exec(text);

    if (text.startsWith('bake pack ') && baked?.[1] !== undefined) {
      this.#current = this.#ensure(path.basename(path.dirname(baked[1])));

      return;
    }

    const entry = /^add archive entry (.+) with size (\d+) vs (\d+)$/.exec(text);

    if (entry) {
      const pack = this.#current ?? this.#ensure('(unknown)');
      const after = Number(entry[2]);

      pack.entries++;

      // A stub lists the file and carries none of it; the file itself is copied out unchanged.
      if (after === 0) {
        pack.stubs++;

        return;
      }

      pack.bytesAfter += after;
      pack.bytesBefore += Number(entry[3]);

      return;
    }

    if (text.startsWith('copy ')) {
      const at = text.lastIndexOf(' to ');
      const owner = at === -1 ? undefined : this.#owner(text.slice(at + ' to '.length));

      if (owner !== undefined) { this.#current = owner; }

      (this.#current ?? this.#ensure('(unknown)')).copied++;

      return;
    }

    if (text.startsWith('extracted ')) {
      (this.#current ?? this.#ensure('(unknown)')).entries++;
    }
  }

  /** The pack a written file belongs to: the first segment of its path below the output root. */
  #owner(destination: string): OptimizedPack | undefined {
    const relative = path.relative(this.outDir, destination.trim());

    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) { return undefined; }

    const name = relative.split(/[\\/]/)[0];

    return name === undefined || name === '' ? undefined : this.#ensure(name);
  }
}

/**
 * Runs the converter over `packsDir` and writes the result to `outDir`.
 *
 * @throws if the server cannot be resolved, the input is not a directory of packs, `outDir`
 * overlaps `packsDir`, a pack is already converted, or the converter reports a failure.
 */
export async function optimizePacks(options: OptimizeOptions): Promise<OptimizeResult> {
  const {
    unpack = false,
    echo = false,
    wallMs = DEFAULT_WALL_MS,
    onProgress = (): void => {},
  } = options;

  const packsDir = path.resolve(options.packsDir);
  const outDir = path.resolve(options.outDir);

  if (!await isDirectory(packsDir)) {
    throw new Error(`${packsDir} is not a directory. Point --packs at the folder holding one subfolder per pack.`);
  }

  if (contains(packsDir, outDir) || contains(outDir, packsDir)) {
    throw new Error(
      `--out ${outDir} overlaps --packs ${packsDir}. The converter clears an existing output pack `
      + 'directory before writing it, so the output must live outside the input tree.',
    );
  }

  const names = await findPacks(packsDir);

  if (names.length === 0) {
    throw new Error(`no packs in ${packsDir} — a pack is a subdirectory with a manifest.json in it.`);
  }

  // Converting an already-converted pack is not a defined operation, and the failure mode is a
  // pack that silently stops loading. Unpacking one is exactly the point.
  const states = await Promise.all(names.map(name => isOptimized(path.join(packsDir, name))));
  const wrong = names.filter((_, index) => states[index] !== unpack);

  if (wrong.length > 0) {
    throw new Error(unpack
      ? `not converted, so there is nothing to unpack: ${wrong.join(', ')}`
      : `already converted (the manifest carries pack_optimization_version): ${wrong.join(', ')}. `
        + 'Build again, or run with --unpack first.');
  }

  const resolved = await resolveBds({
    version: options.bdsVersion,
    channel: options.bdsChannel,
    configPath: options.configPath,
    offline: options.offline,
    onProgress,
  });

  // A previous run's output for these packs, so a pack that no longer emits a file does not keep
  // the old one. Only the directories about to be written are touched.
  for (const name of names) { await fs.rm(path.join(outDir, name), { recursive: true, force: true }); }

  await fs.mkdir(outDir, { recursive: true });

  // The converter parses the config as JSON and takes the paths as written, so they go in
  // absolute and with forward slashes — a Windows path would otherwise need escaping.
  const configDir = path.join(bdsHome(), 'optimize');
  const configFile = path.join(configDir, `pack_optimizer_config-${process.pid}.json`);

  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configFile, `${JSON.stringify({
    input_directory: packsDir.replaceAll('\\', '/'),
    output_directory: outDir.replaceAll('\\', '/'),

    // Undocumented, and the only way back: it expands the archives into loose files again.
    ...unpack ? { unpack: true } : {},

    // Always on. The per-file lines are the only record of what anything weighed before, so they
    // are collected whatever the caller wants echoed.
    verbose_logging: true,
  }, null, 2)}\n`);

  onProgress(`${unpack ? 'unpacking' : 'optimizing'} ${names.length} pack(s) with BDS ${resolved.version}`);

  const started = Date.now();
  const tally = new Tally(outDir);

  try {
    await new Promise<void>((resolve, reject) => {
      const executable = process.platform === 'win32'
        ? path.join(resolved.dir, serverExecutable())
        : `./${serverExecutable()}`;

      const child = spawn(executable, [`PackOptimizerConfigPath=${configFile.replaceAll('\\', '/')}`], {
        cwd: resolved.dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.platform === 'win32'
          ? process.env
          : { ...process.env, LD_LIBRARY_PATH: '.' },
      });

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`the converter did not finish within ${Math.round(wallMs / 1000)}s`));
      }, wallMs);

      timer.unref();

      for (const stream of [child.stdout, child.stderr]) {
        createInterface({ input: stream }).on('line', (line: string) => {
          const text = line.trim();

          // The converter's own lines are unprefixed; the server's logging is `[timestamp LEVEL]`.
          if (text.startsWith('[')) {
            // Documented for Windows builds. Elsewhere the argument may simply be ignored, and a
            // server that starts serving would otherwise sit here until the wall clock.
            if (SERVING_RE.test(text)) {
              clearTimeout(timer);
              child.kill();
              reject(new Error(
                `BDS ${resolved.version} ignored PackOptimizerConfigPath and started serving instead. `
                + 'Pack optimization is documented for Windows builds.',
              ));
            }

            return;
          }

          if (text === '') { return; }

          tally.line(text);

          if (echo) { onProgress(text); }
        });
      }

      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.once('exit', (code) => {
        clearTimeout(timer);

        if (code === 0) {
          resolve();

          return;
        }

        reject(new Error(code === RESOURCE_PROCESSING_ERROR
          ? 'the converter reported ResourceProcessingError (exit 7) — one of the packs could not be processed'
          : `the converter exited ${code ?? 'on a signal'}`));
      });
    });
  } finally {
    await fs.rm(configFile, { force: true });
  }

  for (const pack of tally.packs) {
    pack.sizeBefore = await dirSize(path.join(packsDir, pack.name));
    pack.sizeAfter = await dirSize(path.join(outDir, pack.name));
  }

  return {
    packs: tally.packs,
    bdsVersion: resolved.version,
    outDir,
    durationMs: Date.now() - started,
    unpacked: unpack,
  };
}
