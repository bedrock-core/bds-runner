import path from 'node:path';
import { createInterface } from 'node:readline';
import { loadConfig, logsDir } from './bds/paths';
import { resolveBds } from './bds/resolve';
import { parseReport, type Summary, summarise } from './report/parse';
import { deployPacks, discoverPacks } from './server/packs';
import { provisionServer, resetWorldChunks } from './server/provision';
import { BdsServer } from './server/process';
import { enableBetaApis, writeWorldPackReferences } from './server/world';

export interface RunOptions {

  /** Build directories holding `BP/` and `RP/`, or single packs. More than one installs several addons into the same world. */
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

  /** Run against a build other than the one in the config file, just for this run. */
  bdsVersion?: string;
  bdsChannel?: 'stable' | 'preview';
  configPath?: string;

  /**
   * After the verdicts are in, keep the server running so a person can connect and look at the
   * test plots. The terminal is forwarded to the server console; `stop` or Ctrl+C ends it, and the
   * world is wiped once the server is down.
   */
  keepAlive?: boolean;

  /**
   * Called as soon as the verdicts are in, before the server is stopped. With `keepAlive` this is
   * where the summary is shown, so the person about to connect knows what they are looking at.
   */
  onResult?: (result: RunResult) => void;
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

/** Drops `undefined` values, so an unsupplied CLI flag cannot overwrite a default when spread. */
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

  // `resolveBds` reports the build it actually settled on, which is not the pin when that is
  // `latest` or when BC_BDS_PATH supplied the server.
  const config = loadConfig({
    version: settings.bdsVersion,
    channel: settings.bdsChannel,
    configPath: settings.configPath,
  });
  const bds = await resolveBds({
    onProgress,
    offline: settings.offline,
    version: config.version,
    channel: config.channel,
  });
  const version = bds.version;

  const { worldDir, created } = await provisionServer({
    cacheDir: bds.dir,
    version: bds.source === 'env' ? path.basename(bds.dir) : version,
    levelName: settings.levelName,
    port: settings.port,
    watchdogHangMs: settings.watchdogHangMs,
    lanVisible: settings.keepAlive,
    properties: config.properties,
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

    // The verdicts are fixed here, before anything a person does in the held-open world can add
    // to the transcript. Duration measures the tests, not how long someone spent looking at them.
    const result = buildResult(server.transcript, settings, logFile, version, Date.now() - started);

    settings.onResult?.(result);

    if (settings.keepAlive && !server.exited) {
      await holdForInspection(server, settings.port, onProgress);
    }

    return result;
  } finally {
    await server.dispose();

    // The plots stay while someone is looking; once the server is down the world is wiped.
    if (settings.keepAlive) {
      await resetWorldChunks(worldDir);
      onProgress('world reset');
    }
  }
}

function buildResult(
  transcript: string,
  settings: RunOptions & typeof DEFAULTS,
  logFile: string,
  bdsVersion: string,
  durationMs: number,
): RunResult {
  const summary = summarise(parseReport(transcript));
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

  return { summary, transcript, logFile, durationMs, bdsVersion, regressions };
}

/**
 * Keeps the server up until it is told to stop, with the terminal wired to its console.
 *
 * Anything typed is sent to the server as a command. Ctrl+C asks the server to stop. End of input
 * on stdin, as in a CI job, also stops it.
 */
async function holdForInspection(
  server: BdsServer,
  port: number,
  onProgress: (message: string) => void,
): Promise<void> {
  server.stopGracefullyOnSignal = true;

  onProgress(`server kept running for inspection: connect to 127.0.0.1:${port}`);
  onProgress('type a server command here; `stop` or Ctrl+C ends the session');

  if (process.platform === 'win32') {
    // The Windows Minecraft app is a UWP package, and UWP packages cannot open loopback connections
    // until the package is exempted. One-time, needs an elevated prompt.
    onProgress('Windows: if the client cannot connect to localhost, run once as administrator:');
    onProgress('  CheckNetIsolation LoopbackExempt -a -n=Microsoft.MinecraftUWP_8wekyb3d8bbwe');
  }

  const rl = createInterface({ input: process.stdin });

  const forward = (line: string): void => {
    const command = line.trim();

    if (!command) { return; }

    try {
      server.send(command);
    } catch {
      // The server is already gone; the wait below is about to resolve.
    }
  };

  const onEnd = (): void => forward('stop');

  rl.on('line', forward);
  rl.once('close', onEnd);

  try {
    await server.waitForExit();
  } finally {
    rl.off('close', onEnd);
    rl.close();
  }
}

/**
 * Waits for the run to finish: every announced test has a verdict, or the server has gone quiet,
 * or the wall clock ran out. The engine prints nothing when a run ends.
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

    // Silence ends the run whether or not anything was accounted for; a run that produced nothing
    // has already failed.
    if (server.idleMs >= idleMs) { return; }

    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
