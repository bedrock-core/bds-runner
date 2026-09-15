import fs from 'node:fs/promises';
import path from 'node:path';
import {
  cacheDir,
  CONFIG_FILE,
  findConfig,
  pinnedVersion,
  platformKey,
  projectRoot,
  schemaFile,
  serverDir,
  serverExecutable,
  type VersionOverride,
} from './bds/paths';
import { detectPin } from './bds/detect';
import { optimizePacks } from './bds/optimize';
import { channelOf, fetchIndex, LATEST } from './bds/versions';
import { resolveBds } from './bds/resolve';
import { formatSummary } from './report/summary';
import { runGameTests } from './run';
import { writeConfigSchema } from './server/schema';

/**
 *   0  every test passed, or only known failures did
 *   1  tests failed
 *   2  the run could not be trusted: no server, no boot, nothing announced, a bad tag
 *
 * 1 and 2 are distinct so a broken harness cannot look like broken code.
 */
const EXIT = { ok: 0, testsFailed: 1, infrastructure: 2 };

const USAGE = `
bc-bds — run Minecraft GameTests on a Bedrock Dedicated Server

  bc-bds run --packs <dir> --tag <tag> [options]
  bc-bds optimize --packs <dir> --out <dir> [--unpack]
  bc-bds fetch                 download and cache the server
  bc-bds where                 print the resolved server directory and version

Which server build (any command). Defaults to the newest stable build:
  --bds-version <v>            an exact build, or "latest"
  --bds-channel <c>            stable | preview
  --config <path>              a bds-runner.json to read instead of searching

Options for \`run\`:
  --packs <dir>                directory containing BP/ and RP/; repeatable, so
                               several addons share one world            (required)
  --tag <tag>                  gametest tag to run                       (required)
  --expect-registered <n>      fail unless the engine announces n tests
  --known-failure <id>         a test expected to fail; repeatable
  --allow-script-errors        report uncaught script errors without failing
  --origin "<x> <y> <z>"       where to place the test plots     (default "8 -60 8")
  --idle <seconds>             quiet time that ends a run                (default 45)
  --timeout <seconds>          wall-clock limit for the whole run       (default 900)
  --port <n>                   server port                            (default 19140)
  --fresh                      recreate the server tree and world from scratch
  --keep-alive                 after the results, keep the server up so you can
                               join and look at the plots; \`stop\` or Ctrl+C ends it
  --offline                    never download; fail if the cache is cold
  --quiet                      do not echo server output
  --json <path>                also write the result as JSON

Options for \`optimize\` — pack the loose files of built packs into archives, the way
the game ships its own. A converted pack needs a 1.26.40 or newer client:
  --packs <dir>                directory holding one subfolder per pack; Regolith's
                               build/ is already this shape                (required)
  --out <dir>                  where the converted packs are written; has to sit
                               outside --packs                             (required)
  --unpack                     the other direction: expand a converted tree back into
                               loose files. JSON comes back minified, not as authored
  --verbose                    echo the converter's own per-file lines
  --offline                    never download; fail if the cache is cold
`.trimStart();

interface Args {
  command: string;
  values: Map<string, string[]>;
  flags: Set<string>;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const command = argv[0] ?? 'help';

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];

    if (!arg.startsWith('--')) { continue; }

    const key = arg.slice(2);
    const next = argv[i + 1];

    if (next === undefined || next.startsWith('--')) {
      flags.add(key);
    } else {
      values.set(key, [...values.get(key) ?? [], next]);
      i++;
    }
  }

  return { command, values, flags };
}

const first = (args: Args, key: string): string | undefined => args.values.get(key)?.[0];

const number = (args: Args, key: string): number | undefined => {
  const raw = first(args, key);

  if (raw === undefined) { return undefined; }

  const value = Number(raw);

  if (!Number.isFinite(value)) { throw new Error(`--${key} must be a number, got "${raw}"`); }

  return value;
};

/** `--bds-version` / `--bds-channel` / `--config`, accepted by every command. */
function versionOverride(args: Args): VersionOverride {
  const channel = first(args, 'bds-channel');

  if (channel !== undefined && channel !== 'stable' && channel !== 'preview') {
    throw new Error(`--bds-channel must be "stable" or "preview", got "${channel}"`);
  }

  return {
    version: first(args, 'bds-version'),
    channel,
    configPath: first(args, 'config'),
  };
}

async function commandRun(args: Args): Promise<number> {
  const packsDirs = args.values.get('packs') ?? [];
  const tag = first(args, 'tag');

  if (packsDirs.length === 0 || !tag) {
    process.stderr.write('bc-bds run needs both --packs and --tag\n\n');
    process.stderr.write(USAGE);

    return EXIT.infrastructure;
  }

  const idle = number(args, 'idle');
  const timeout = number(args, 'timeout');
  const bds = versionOverride(args);
  const knownFailures = args.values.get('known-failure') ?? [];

  const result = await runGameTests({
    packsDirs,
    tag,
    bdsVersion: bds.version,
    bdsChannel: bds.channel,
    configPath: bds.configPath,
    expectRegistered: number(args, 'expect-registered'),
    knownFailures,
    origin: first(args, 'origin'),
    port: number(args, 'port'),
    idleMs: idle === undefined ? undefined : idle * 1000,
    wallMs: timeout === undefined ? undefined : timeout * 1000,
    fresh: args.flags.has('fresh'),
    offline: args.flags.has('offline'),
    keepAlive: args.flags.has('keep-alive'),
    allowScriptErrors: args.flags.has('allow-script-errors'),
    echo: !args.flags.has('quiet'),
    onProgress: message => process.stdout.write(`  ${message}\n`),

    // Printed the moment the verdicts are in, so with --keep-alive the summary comes before the
    // server is handed over rather than after it is finally stopped.
    onResult: (r) => {
      process.stdout.write('\n');
      process.stdout.write(formatSummary({
        summary: r.summary,
        durationMs: r.durationMs,
        bdsVersion: r.bdsVersion,
        transcript: r.transcript,
        knownFailures,
      }));
      process.stdout.write(`\n  log: ${r.logFile}\n\n`);
    },
  });

  const jsonPath = first(args, 'json');

  if (jsonPath) {
    await fs.mkdir(path.dirname(path.resolve(jsonPath)), { recursive: true });
    await fs.writeFile(jsonPath, `${JSON.stringify({
      tag,
      bdsVersion: result.bdsVersion,
      durationMs: result.durationMs,
      verdicts: result.summary.verdicts,
      regressions: result.regressions,
      scriptErrors: result.summary.scriptErrors,
      infraError: result.summary.infraError,
    }, null, 2)}\n`);
  }

  if (result.summary.infraError) { return EXIT.infrastructure; }

  return result.regressions.length > 0 ? EXIT.testsFailed : EXIT.ok;
}

const KB = 1024;
const MB = KB * 1024;

function bytes(value: number): string {
  if (value < KB) { return `${value} B`; }

  if (value < MB) { return `${(value / KB).toFixed(0)} KB`; }

  return `${(value / MB).toFixed(1)} MB`;
}

async function commandOptimize(args: Args): Promise<number> {
  const packsDir = first(args, 'packs');
  const outDir = first(args, 'out');

  if (!packsDir || !outDir) {
    process.stderr.write('bc-bds optimize needs both --packs and --out\n\n');
    process.stderr.write(USAGE);

    return EXIT.infrastructure;
  }

  const bds = versionOverride(args);
  const result = await optimizePacks({
    packsDir,
    outDir,
    unpack: args.flags.has('unpack'),
    echo: args.flags.has('verbose'),
    offline: args.flags.has('offline'),
    bdsVersion: bds.version,
    bdsChannel: bds.channel,
    configPath: bds.configPath,
    onProgress: message => process.stdout.write(`  ${message}\n`),
  });

  process.stdout.write('\n');

  for (const pack of result.packs) {
    const delta = pack.sizeBefore === 0
      ? ''
      : ` (${pack.sizeAfter <= pack.sizeBefore ? '−' : '+'}${
        Math.abs(100 - (pack.sizeAfter / pack.sizeBefore) * 100).toFixed(1)}%)`;

    process.stdout.write(`  ${pack.name} — ${bytes(pack.sizeBefore)} → ${bytes(pack.sizeAfter)}${delta}\n`);
    process.stdout.write(result.unpacked
      ? `      ${pack.entries} file(s) extracted, ${pack.copied} copied\n`
      : `      ${pack.entries} archived (${bytes(pack.bytesBefore)} → ${bytes(pack.bytesAfter)})`
        + `${pack.stubs > 0 ? `, ${pack.stubs} listed only` : ''}`
        + `, ${pack.copied} copied out\n`);
  }

  process.stdout.write(`\n  BDS ${result.bdsVersion}, ${(result.durationMs / 1000).toFixed(1)}s → ${result.outDir}\n`);

  if (!result.unpacked) {
    process.stdout.write('  Converted packs require a 1.26.40 or newer client.\n');
  }

  process.stdout.write('\n');

  return EXIT.ok;
}

async function commandFetch(args: Args): Promise<number> {
  const resolved = await resolveBds({
    ...versionOverride(args),
    onProgress: m => process.stdout.write(`  ${m}\n`),
  });

  process.stdout.write(
    `Bedrock Dedicated Server ${resolved.version} ready (${resolved.source}): ${resolved.dir}\n`,
  );

  return EXIT.ok;
}

/** Reports where the server will come from and what upstream currently offers. An unreachable index is an error. */
async function commandWhere(args: Args): Promise<number> {
  const override = versionOverride(args);
  const platform = platformKey();
  const config = override.configPath ?? findConfig();

  // A project with no config gets its build detected on the next run, so that is the build this
  // report is about. `where` works it out the same way and writes nothing: it reports, it does
  // not decide.
  const detected = config === undefined && override.version === undefined && !process.env.BC_BDS_PATH
    ? await detectPin(projectRoot(), platform).catch(() => undefined)
    : undefined;

  const pinned = detected === undefined
    ? pinnedVersion(override)
    : { version: detected.version, channel: detected.channel };

  process.stdout.write(`selected: ${pinned.version} (${pinned.channel}, ${platform})\n`);
  process.stdout.write(`config:   ${config ?? 'none found'}\n`);

  if (config === undefined && override.version === undefined && !process.env.BC_BDS_PATH) {
    process.stdout.write(detected === undefined
      ? 'detected: nothing — no manifest declares min_engine_version, so the newest stable build is used\n'
      : `detected: min_engine_version ${detected.floor} in ${detected.manifests} manifest(s);`
        + ` ${CONFIG_FILE} is written on the next run\n`);
  }

  process.stdout.write(`project:  ${projectRoot()}\n`);

  if (process.env.BC_BDS_PATH) { process.stdout.write(`override: BC_BDS_PATH=${process.env.BC_BDS_PATH}\n`); }

  const index = await fetchIndex(platform);
  const { current: latest, versions: published } = channelOf(index, pinned.channel);
  const target = pinned.version === LATEST ? latest : pinned.version;

  const cache = cacheDir(target, platform);

  // The schema needs the server's own server.properties, so it can be refreshed here only when the
  // build is already cached.
  const cached = await fs.access(path.join(cache, serverExecutable())).then(() => true, () => false);

  if (cached) { await writeConfigSchema(cache, target, schemaFile()); }

  process.stdout.write(`resolved: ${target}\n`);
  process.stdout.write(`cache:    ${cache}${cached ? '' : ' (not downloaded yet)'}\n`);
  process.stdout.write(`server:   ${serverDir(target)}\n`);
  process.stdout.write(`schema:   ${schemaFile()}${cached ? '' : ' (written on first fetch)'}\n`);
  process.stdout.write(`\nupstream: stable ${index.stable}, preview ${index.preview} `);
  process.stdout.write(`(${index.versions.length} stable and ${index.previewVersions.length} preview builds indexed)\n`);

  if (pinned.version !== LATEST && latest !== pinned.version) {
    process.stdout.write(`\nA newer ${pinned.channel} build is available: ${latest}.\n`);
    process.stdout.write(`Set "version" in ${config ?? `a ${CONFIG_FILE} in ${projectRoot()}`}, `);
    process.stdout.write('or pass --bds-version.\n');
  }

  if (pinned.version !== LATEST && !published.includes(pinned.version)) {
    process.stdout.write(`\nWARNING: ${pinned.version} is not a published ${pinned.channel} build — check the pin and channel.\n`);
  }

  return EXIT.ok;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  switch (args.command) {
    case 'run': return commandRun(args);
    case 'optimize': return commandOptimize(args);
    case 'fetch': return commandFetch(args);
    case 'where': return commandWhere(args);
    default:
      process.stdout.write(USAGE);

      return args.command === 'help' ? EXIT.ok : EXIT.infrastructure;
  }
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    process.stderr.write(`\nbc-bds failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT.infrastructure;
  });
