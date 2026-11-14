import path from 'node:path';
import { createInterface } from 'node:readline';
import { loadConfig, logsDir, resolveInstance, serverDir as instanceDirectory } from './bds/paths';
import { resolveBds } from './bds/resolve';
import { parseReport, type Summary, summarise } from './report/parse';
import { deployPacks, discoverPacks } from './server/packs';
import { discardWorld, provisionServer, resetWorldChunks } from './server/provision';
import { BdsServer } from './server/process';
import { enableBetaApis, writeWorldPackReferences } from './server/world';
import { withInstanceLock } from './server/lock';
import { ScriptProfiler, type ScriptProfile } from './server/profile';
import { connectDebugger } from './server/debugger';
import type { PropertyValue } from './server/properties';
import { testSelection } from './server/test-selection';
import { summariseSelection } from './report/selection';

export interface RunOptions {

  /** Build directories holding `BP/` and `RP/`, or single packs. More than one installs several addons into the same world. */
  packsDirs: string | readonly string[];

  /** The gametest tag to run, e.g. `bc:constructs:m3`. */
  tag?: string;
  /** Run one registered test by its class:name identifier. */
  test?: string;
  /** Run selected tests sequentially in one server session. */
  tests?: readonly string[];
  /** Run the default native test set for the deployed packs. */
  all?: boolean;
  /** Cooperatively stop this run's server when cancelled. */
  signal?: AbortSignal;

  /** Fail if the engine announces a different number of tests. Catches silently dropped suites. */
  expectRegistered?: number;

  /** Ids that are expected to fail; they do not make the run red. */
  knownFailures?: string[];

  /**
   * Report uncaught script errors without failing the run.
   *
   * They are always reported. By default one also fails the run, because an exception thrown
   * outside a test's call stack cannot fail a test and would otherwise leave a green build.
   */
  allowScriptErrors?: boolean;

  levelName?: string;
  /** Reuse .bds/server/<instance> instead of a version-named tree. */
  instance?: string;
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

  /** Per-run server properties, overriding the project configuration. */
  properties?: Record<string, PropertyValue>;
  /** Connect to a listening Minecraft VS Code debugger before running tests. */
  debug?: { port?: number; timeoutMs?: number };
  /** Capture native CPU profiles and diagnostics for the test run. */
  profile?: boolean | { directory?: string };
  /** Prepare instrumentation or command subscriptions after startup, before the test set begins. */
  onServerReady?: (server: BdsServer, serverDir: string) => void | Promise<void>;

  /**
   * After the verdicts are in, keep the server running so a person can connect and look at the
   * test plots. The terminal is forwarded to the server console; `stop` or Ctrl+C ends it, and the
   * world is wiped once the server is down.
   */
  keepAlive?: boolean;

  /**
   * Called as soon as the verdicts are in, before the server is stopped. With `keepAlive` this is
   * where the summary is shown, so the person about to connect knows what they are looking at.
   * Awaited while BDS remains alive so external capture processing can finish.
   */
  onResult?: (result: RunResult) => void | Promise<void>;
  onProgress?: (message: string) => void;
}

export interface RunResult {
  summary: Summary;
  transcript: string;
  logFile: string;
  durationMs: number;
  bdsVersion: string;
  profile?: ScriptProfile;

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
  const selection = testSelection(options);

  options.signal?.throwIfAborted();
  const settings = { ...DEFAULTS, ...definedOnly(options) } as RunOptions & typeof DEFAULTS;

  const selectedTests = options.tests ?? (options.test ? [options.test] : undefined);

  if (selectedTests && options.expectRegistered === undefined) { settings.expectRegistered = selectedTests.length; }

  const onProgress = options.onProgress ?? ((): void => {});
  const started = Date.now();
  const debugPort = settings.debug?.port ?? 19144;

  if (settings.debug && (!Number.isSafeInteger(debugPort) || debugPort < 1 || debugPort > 65535)) { throw new Error('Debugger port must be an integer from 1 to 65535'); }

  if (settings.debug?.timeoutMs !== undefined && (!Number.isFinite(settings.debug.timeoutMs) || settings.debug.timeoutMs <= 0)) { throw new Error('Debugger timeout must be positive'); }

  const packs = await discoverPacks(settings.packsDirs);

  onProgress(`packs: ${packs.map(p => `${p.name} (${p.kind}, ${p.slug})`).join(', ')}`);

  // `resolveBds` reports the build it actually settled on, which is not the pin when that is
  // `latest` or when BC_BDS_PATH supplied the server.
  const config = loadConfig({
    version: settings.bdsVersion,
    channel: settings.bdsChannel,
    configPath: settings.configPath,
  });
  const selected = resolveInstance(config, { instance: options.instance, port: options.port });

  settings.port = selected.port;
  const bds = await resolveBds({
    onProgress,
    offline: settings.offline,
    version: config.version,
    channel: config.channel,
  });
  const version = bds.version;

  return withInstanceLock(instanceDirectory(bds.source === 'env' ? path.basename(bds.dir) : version, selected.instance), async () => {
    options.signal?.throwIfAborted();
    const { serverDir, worldDir, created } = await provisionServer({
      cacheDir: bds.dir,
      version: bds.source === 'env' ? path.basename(bds.dir) : version,
      instance: selected.instance,
      levelName: settings.levelName,
      port: settings.port,
      watchdogHangMs: settings.watchdogHangMs,
      lanVisible: settings.keepAlive && config.properties['enable-lan-visibility'] !== false,
      properties: { 'online-mode': settings.keepAlive === true, ...config.properties, ...settings.properties,
        ...(settings.debug ? { 'allow-outbound-script-debugging': true } : {}),
        ...(settings.profile ? { 'diagnostics-capture-max-files': 1000, 'diagnostics-capture-max-file-size': 33554432 } : {}),
      },
      fresh: settings.fresh,
      onProgress,
    });

    const logInstance = selected.instance === undefined ? '' : `${selected.instance}-`;
    const logFile = path.join(logsDir(), `${timestamp()}-${logInstance}${selection.label.replace(/[^\w.-]+/g, '_')}.log`);

    // A world only exists after BDS has generated it, and experiments can only be set on a world that
    // exists. So the very first run on a new server tree is two boots: one to create the world, one to
    // run the tests with Beta APIs on. Every later run is a single boot.
    if (created) {
      onProgress('first run for this server: generating the world');
      const bootstrap = new BdsServer({ serverDir, logFile: `${logFile}.bootstrap`, echo: settings.echo });
      const detachAbort = stopOnAbort(options.signal, bootstrap);

      // Disposed whichever way the boot ends: a fatal line during generation must not leave the
      // server process behind, holding the port and the world.
      try {
        options.signal?.throwIfAborted();
        await bootstrap.start();
        options.signal?.throwIfAborted();
        await bootstrap.waitForReady();
        options.signal?.throwIfAborted();
        await bootstrap.stop();

        const result = await enableBetaApis(worldDir, config.experiments);

        onProgress(`enabled experiments: ${result.experiments.join(', ')}`);
      } catch (error) {
      // level.dat can exist even when the initial boot or experiment write fails. Leaving it
      // behind makes provisioning treat the world as ready and skips the only point that enables
      // Beta APIs, so the next run fails until someone manually passes --fresh.
        await discardWorld(worldDir);
        onProgress('first boot did not finish; discarded the incomplete world');

        throw error;
      } finally {
        detachAbort();
        await bootstrap.dispose();
      }
    } else if (config.experiments?.length) {
      const result = await enableBetaApis(worldDir, config.experiments);

      if (result.changed) { onProgress(`enabled experiments: ${result.experiments.join(', ')}`); }
    }

    await resetWorldChunks(worldDir);
    const deployment = await deployPacks(serverDir, worldDir, packs);

    if (deployment.resourceStackHash) {
      onProgress(`resource stack: ${deployment.resourceStackHash} (${deployment.recordFile})`);
    }

    await writeWorldPackReferences(
      worldDir,
      deployment.packs.filter(p => p.kind === 'behavior').map(p => ({ packId: p.packId, version: p.version })),
      deployment.packs.filter(p => p.kind === 'resource').map(p => ({ packId: p.packId, version: p.version })),
    );

    const server = new BdsServer({
      serverDir,
      logFile,
      echo: settings.echo,
    });
    const detachAbort = stopOnAbort(options.signal, server);
    let profiler: ScriptProfiler | undefined;
    let profile: ScriptProfile | undefined;

    try {
      options.signal?.throwIfAborted();
      await server.start();
      options.signal?.throwIfAborted();
      await server.waitForReady();
      options.signal?.throwIfAborted();

      // BDS prints the toggles it honoured. Checking the log rather than re-reading the NBT catches
      // the case where the file says one thing and the engine did another.
      if (!/Experiment\(s\) active:.*gtst/.test(server.transcript)) {
        throw new Error(
          'the server started without Beta APIs active, so /gametest does not exist. '
          + `Delete the server tree and retry with --fresh, or check ${path.join(worldDir, 'level.dat')}.`,
        );
      }

      server.send('gamerule sendcommandfeedback true');
      // Keep the playerless world active while the debugger performs its protocol handshake.
      server.send('tickingarea add 0 -64 0 128 120 128 bc_test true');

      if (settings.debug) {
        onProgress(`Minecraft debugger waiting for VS Code on localhost:${debugPort}; start minecraft-js in listen mode`);
        await connectDebugger(server, debugPort, settings.debug.timeoutMs ?? 120000);
      }

      await settings.onServerReady?.(server, serverDir);

      if (settings.profile) {
        const directory = typeof settings.profile === 'object' ? settings.profile.directory : undefined;

        profiler = new ScriptProfiler(server, serverDir, directory ?? path.join(logsDir(), 'profiles', path.basename(logFile, '.log')));
        await profiler.start();
      }

      options.signal?.throwIfAborted();
      const fragments: string[] = [];
      const deadline = Date.now() + settings.wallMs;

      if (selectedTests) {
        for (const id of selectedTests) {
          options.signal?.throwIfAborted();

          if (Date.now() >= deadline) { break; }

          server.send(`execute in overworld positioned ${settings.origin} run gametest clearall`);
          const offset = server.transcript.length;

          onProgress(`running ${id}`);
          server.send(`execute in overworld positioned ${settings.origin} run gametest run ${id}`);
          await waitForRun(server, settings.idleMs, Math.max(1, deadline - Date.now()), 1, offset);
          fragments.push(server.transcript.slice(offset));

          if (server.exited) { break; }
        }
      } else {
        onProgress(`running ${selection.label}`);
        server.send(`execute in overworld positioned ${settings.origin} run ${selection.command}`);
        await waitForRun(server, settings.idleMs, settings.wallMs, settings.expectRegistered);
      }

      options.signal?.throwIfAborted();

      if (profiler) {
        const capture = profiler;

        profiler = undefined;
        profile = await capture.stop();
        onProgress(`native captures: ${profile.directory}`);
      }

      // The verdicts are fixed here, before anything a person does in the held-open world can add
      // to the transcript. Duration measures the tests, not how long someone spent looking at them.
      const result = buildResult(server.transcript, settings, logFile, version, Date.now() - started, selectedTests ? summariseSelection(server.transcript, fragments, selectedTests) : undefined);

      if (profile) { result.profile = profile; }

      await settings.onResult?.(result);

      if (settings.keepAlive && !server.exited) {
        await holdForInspection(server, settings.port, onProgress);
      }

      return result;
    } finally {
      detachAbort();

      if (profiler) { await profiler.stop().catch(error => onProgress(`profiling cleanup: ${String(error)}`)); }

      await server.dispose();

      // The plots stay while someone is looking; once the server is down the world is wiped.
      if (settings.keepAlive) {
        await resetWorldChunks(worldDir);
        onProgress('world reset');
      }
    }
  });
}

function stopOnAbort(signal: AbortSignal | undefined, server: BdsServer): () => void {
  const stop = (): void => { void server.stop(3000); };

  signal?.addEventListener('abort', stop, { once: true });

  if (signal?.aborted) { stop(); }

  return () => signal?.removeEventListener('abort', stop);
}

function buildResult(
  transcript: string,
  settings: RunOptions & typeof DEFAULTS,
  logFile: string,
  bdsVersion: string,
  durationMs: number,
  selectedSummary?: Summary,
): RunResult {
  const summary = selectedSummary ?? summarise(parseReport(transcript));
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

  if (!settings.allowScriptErrors && summary.infraError === null && summary.scriptErrors.length > 0) {
    summary.infraError
      = `${summary.scriptErrors.length} uncaught script error(s) were logged. They are thrown outside `
        + 'any test, so no test can fail on them. Pass --allow-script-errors to report without failing.';
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
  offset = 0,
): Promise<void> {
  const deadline = Date.now() + wallMs;

  for (;;) {
    if (server.exited) { return; }

    const report = parseReport(server.transcript.slice(offset));
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
