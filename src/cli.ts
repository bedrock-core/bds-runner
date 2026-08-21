import fs from 'node:fs/promises';
import path from 'node:path';
import { cacheDir, pinnedVersion, platformKey, serverDir } from './bds/paths';
import { fetchIndex } from './bds/versions';
import { resolveBds } from './bds/resolve';
import { formatSummary } from './report/summary';
import { runGameTests } from './run';

/**
 * Exit codes are the whole point of this tool, so they mean distinct things:
 *
 *   0  every test passed (or only known failures did)
 *   1  tests failed — the suite is red
 *   2  the run could not be trusted: no server, no boot, nothing announced, a bad tag
 *
 * Conflating 1 and 2 would let a broken harness masquerade as a broken codebase.
 */
const EXIT = { ok: 0, testsFailed: 1, infrastructure: 2 };

const USAGE = `
bc-bds — run Minecraft GameTests on a Bedrock Dedicated Server

  bc-bds run --packs <dir> --tag <tag> [options]
  bc-bds fetch                 download and cache the pinned server
  bc-bds where                 print the resolved server directory and version

Options for \`run\`:
  --packs <dir>                directory containing BP/ and RP/; repeatable, so
                               several addons share one world            (required)
  --tag <tag>                  gametest tag to run                       (required)
  --expect-registered <n>      fail unless the engine announces n tests
  --known-failure <id>         a test expected to fail; repeatable
  --origin "<x> <y> <z>"       where to place the test plots     (default "8 -60 8")
  --idle <seconds>             quiet time that ends a run                (default 45)
  --timeout <seconds>          wall-clock limit for the whole run       (default 900)
  --port <n>                   server port                            (default 19140)
  --fresh                      recreate the server tree and world from scratch
  --offline                    never download; fail if the cache is cold
  --quiet                      do not echo server output
  --json <path>                also write the result as JSON
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

  return raw === undefined ? undefined : Number(raw);
};

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

  const result = await runGameTests({
    packsDirs,
    tag,
    expectRegistered: number(args, 'expect-registered'),
    knownFailures: args.values.get('known-failure') ?? [],
    origin: first(args, 'origin'),
    port: number(args, 'port'),
    idleMs: idle === undefined ? undefined : idle * 1000,
    wallMs: timeout === undefined ? undefined : timeout * 1000,
    fresh: args.flags.has('fresh'),
    offline: args.flags.has('offline'),
    echo: !args.flags.has('quiet'),
    onProgress: message => process.stdout.write(`  ${message}\n`),
  });

  process.stdout.write('\n');
  process.stdout.write(formatSummary({
    summary: result.summary,
    durationMs: result.durationMs,
    bdsVersion: result.bdsVersion,
    transcript: result.transcript,
    knownFailures: args.values.get('known-failure') ?? [],
  }));
  process.stdout.write(`\n  log: ${result.logFile}\n`);

  const jsonPath = first(args, 'json');

  if (jsonPath) {
    await fs.mkdir(path.dirname(path.resolve(jsonPath)), { recursive: true });
    await fs.writeFile(jsonPath, `${JSON.stringify({
      tag,
      bdsVersion: result.bdsVersion,
      durationMs: result.durationMs,
      verdicts: result.summary.verdicts,
      regressions: result.regressions,
      infraError: result.summary.infraError,
    }, null, 2)}\n`);
  }

  if (result.summary.infraError) { return EXIT.infrastructure; }

  return result.regressions.length > 0 ? EXIT.testsFailed : EXIT.ok;
}

async function commandFetch(): Promise<number> {
  const resolved = await resolveBds({ onProgress: m => process.stdout.write(`  ${m}\n`) });

  process.stdout.write(`Bedrock Dedicated Server ready (${resolved.source}): ${resolved.dir}\n`);

  return EXIT.ok;
}

async function commandWhere(): Promise<number> {
  const pinned = pinnedVersion();
  const platform = platformKey();

  process.stdout.write(`pinned:   ${pinned.version} (${pinned.channel}, ${platform})\n`);
  process.stdout.write(`cache:    ${cacheDir(pinned.version, platform)}\n`);
  process.stdout.write(`server:   ${serverDir(pinned.version)}\n`);

  if (process.env.BC_BDS_PATH) { process.stdout.write(`override: BC_BDS_PATH=${process.env.BC_BDS_PATH}\n`); }

  // Version data comes from github.com/Bedrock-OSS/BDS-Versions, which is reachable on networks
  // that block minecraft.net — so this stays useful even where `fetch` cannot run.
  const index = await fetchIndex(platform).catch(() => null);

  if (!index) {
    process.stdout.write('\ncould not reach BDS-Versions to check for newer builds\n');

    return EXIT.ok;
  }

  process.stdout.write(`\nupstream: stable ${index.stable}, preview ${index.preview} `);
  process.stdout.write(`(${index.versions.length} builds indexed)\n`);

  const latest = pinned.channel === 'preview' ? index.preview : index.stable;

  if (latest !== pinned.version) {
    process.stdout.write(`\nA newer ${pinned.channel} build is available: ${latest}.\n`);
    process.stdout.write('Bump "version" in packages/bds-runner/bds-version.json and re-run the suites.\n');
  }

  if (!index.versions.includes(pinned.version)) {
    process.stdout.write(`\nWARNING: ${pinned.version} is not in the BDS-Versions index — check the pin.\n`);
  }

  return EXIT.ok;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  switch (args.command) {
    case 'run': return commandRun(args);
    case 'fetch': return commandFetch();
    case 'where': return commandWhere();
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
