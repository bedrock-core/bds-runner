import path from 'node:path';
import { logsDir, pinnedVersion } from './bds/paths';
import { resolveBds } from './bds/resolve';
import { parseReport, type Summary, summarise } from './report/parse';
import { deployPacks, discoverPacks } from './server/packs';
import { provisionServer, resetWorldChunks } from './server/provision';
import { BdsServer } from './server/process';
import { enableBetaApis, writeWorldPackReferences } from './server/world';

export interface RunOptions {

  /**
   * Directories holding `BP/` and `RP/`, as exported by a Regolith `exact` profile.
   *
   * More than one deploys several addons into the same world, which is the only way a cross-addon
   * test — one that asserts a *different* pack is present — can pass.
   */
  packsDirs: string | readonly string[];

  /** The gametest tag to run, e.g. `bc:constructs:m3`. */
  tag: string;

  /** Fail if the engine announces a different number of tests. Catches silently dropped suites. */
  expectRegistered?: number;

  /** Ids that are expected to fail; they do not make the run red. */
  knownFailures?: string[];

  levelName?: string;
  port?: number;
  origin?: string;
  idleMs?: number;
  wallMs?: number;
  watchdogHangMs?: number;
  fresh?: boolean;
  echo?: boolean;
  offline?: boolean;
  onProgress?: (message: string) => void;
}

export interface RunResult {
  summary: Summary;
  transcript: string;
  logFile: string;
  durationMs: number;
  bdsVersion: string;

  /** Failures that are not in `knownFailures` — the set that should turn a build red. */
  regressions: string[];
}

const DEFAULTS = {
  levelName: 'bc-test',
  port: 19140,

  /**
   * Where the plots get placed. y = -60 sits just above bedrock in a flat world, so a test's
   * structure has room below it and nothing above to fall on it.
   */
  origin: '8 -60 8',

  /** Quiet for this long with everything accounted for means the run is over. */
  idleMs: 45_000,
  wallMs: 15 * 60_000,

  /** The in-game hang detector, raised well past the 10 s default. See `properties.ts`. */
  watchdogHangMs: 60_000,
};

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Runs a gametest suite on a real Bedrock Dedicated Server and reports what happened.
 *
 * The shape of the run comes from what the engine actually does, established by running it:
 *
 *  - the server must be told to keep the test area loaded, because a world with no player connected
 *    does not tick chunks, and a suite full of redstone and physics would sit still and time out;
 *  - `runset` is issued through `execute … positioned` so the plots land somewhere known rather
 *    than wherever the command origin happens to be;
 *  - there is no "run finished" line to wait for, so the run ends when every announced test has a
 *    verdict, or the server goes quiet, or the wall clock runs out.
 */
/**
 * Drops keys whose value is `undefined`, so spreading the result cannot erase a default.
 *
 * The CLI builds its options object with a key for every flag it knows about, so an unsupplied
 * `--origin` arrives as `origin: undefined`. A plain spread would let that overwrite the default,
 * and the symptom is a server command containing the literal text `undefined`.
 */
function definedOnly<T extends object>(source: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

export async function runGameTests(options: RunOptions): Promise<RunResult> {
  const settings = { ...DEFAULTS, ...definedOnly(options) } as RunOptions & typeof DEFAULTS;
  const onProgress = options.onProgress ?? ((): void => {});
  const started = Date.now();

  const packs = await discoverPacks(settings.packsDirs);

  onProgress(`packs: ${packs.map(p => `${p.name} (${p.kind}, ${p.slug})`).join(', ')}`);

  const bds = await resolveBds({ onProgress, offline: settings.offline });
  const version = bds.source === 'env' ? bds.version : pinnedVersion().version;

  const { worldDir, created } = await provisionServer({
    cacheDir: bds.dir,
    version: bds.source === 'env' ? path.basename(bds.dir) : version,
    levelName: settings.levelName,
    port: settings.port,
    watchdogHangMs: settings.watchdogHangMs,
    fresh: settings.fresh,
    onProgress,
  });

  const logFile = path.join(logsDir(), `${timestamp()}-${settings.tag.replace(/[^\w.-]+/g, '_')}.log`);

  // A world only exists after BDS has generated it, and experiments can only be set on a world that
  // exists. So the very first run on a new server tree is two boots: one to create the world, one to
  // run the tests with Beta APIs on. Every later run is a single boot.
  if (created) {
    onProgress('first run for this server: generating the world');
    const bootstrap = new BdsServer({ serverDir: path.dirname(path.dirname(worldDir)), logFile: `${logFile}.bootstrap`, echo: settings.echo });

    await bootstrap.start();
    await bootstrap.waitForReady();
    await bootstrap.stop();

    const result = await enableBetaApis(worldDir);

    onProgress(`enabled experiments: ${result.experiments.join(', ')}`);
  }

  await resetWorldChunks(worldDir);
  await deployPacks(worldDir, packs);
  await writeWorldPackReferences(
    worldDir,
    packs.filter(p => p.kind === 'behavior').map(p => ({ packId: p.packId, version: p.version })),
    packs.filter(p => p.kind === 'resource').map(p => ({ packId: p.packId, version: p.version })),
  );

  const server = new BdsServer({
    serverDir: path.dirname(path.dirname(worldDir)),
    logFile,
    echo: settings.echo,
  });

  try {
    await server.start();
    await server.waitForReady();

    // BDS prints the toggles it honoured. Checking the log rather than re-reading the NBT catches
    // the case where the file says one thing and the engine did another.
    if (!/Experiment\(s\) active:.*gtst/.test(server.transcript)) {
      throw new Error(
        'the server started without Beta APIs active, so /gametest does not exist. '
        + `Delete the server tree and retry with --fresh, or check ${path.join(worldDir, 'level.dat')}.`,
      );
    }

    server.send('gamerule sendcommandfeedback true');

    // Without a loaded ticking area a playerless world does not simulate, and every test that waits
    // for anything to move times out. `true` preloads it so the first test does not race the load.
    server.send(`tickingarea add 0 -64 0 128 120 128 bc_test true`);
    onProgress(`running ${settings.tag}`);
    server.send(`execute in overworld positioned ${settings.origin} run gametest runset ${settings.tag}`);

    await waitForRun(server, settings.idleMs, settings.wallMs, settings.expectRegistered);
  } finally {
    await server.dispose();
  }

  const summary = summarise(parseReport(server.transcript));
  const knownFailures = settings.knownFailures ?? [];
  const regressions = summary.verdicts
    .filter(v => v.outcome !== 'pass' && !knownFailures.includes(v.id))
    .map(v => v.id);

  if (settings.expectRegistered !== undefined && summary.expected !== null
    && summary.expected !== settings.expectRegistered) {
    summary.infraError
      = `expected ${settings.expectRegistered} registered tests but the engine announced ${summary.expected}. `
        + 'A suite was probably added, removed, or failed to register.';
  }

  return {
    summary,
    transcript: server.transcript,
    logFile,
    durationMs: Date.now() - started,
    bdsVersion: version,
    regressions,
  };
}

/**
 * Waits for the run to finish.
 *
 * "Finished" is a judgement, not an event: the engine announces how many tests it will run and then
 * reports each one, but prints nothing at the end. So the run is over once every announced test has
 * a verdict — and if that never happens, the server going quiet is the fallback, with the wall clock
 * behind that. All three exits are normal; the verdict table decides pass or fail, not this.
 */
async function waitForRun(
  server: BdsServer,
  idleMs: number,
  wallMs: number,
  expectRegistered?: number,
): Promise<void> {
  const deadline = Date.now() + wallMs;

  for (;;) {
    if (server.exited) { return; }

    const report = parseReport(server.transcript);
    const accounted = report.passed.length + report.failed.length;
    const expected = report.expected ?? expectRegistered;

    if (expected !== undefined && expected !== null && accounted >= expected) { return; }

    if (report.noTestsForTag !== null) { return; }

    if (Date.now() >= deadline) { return; }

    // Silence ends the run whether or not anything was accounted for. Waiting longer because we
    // *expected* results is exactly backwards: a run that produced nothing has already failed, and
    // making it burn the full wall clock turns a fast, clear failure into a slow, confusing one.
    if (server.idleMs >= idleMs) { return; }

    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
