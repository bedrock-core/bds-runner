import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { serverExecutable } from '../bds/paths';

/** `[2026-08-10 21:08:29:300 INFO] Server started.` — verified on BDS 1.26.43.1. */
const READY_RE = /\bServer started\b/;

/**
 * Boot failures worth aborting on rather than waiting out the ready timeout. A pack that fails to
 * load still lets the server start, so these are checked for the whole run, not just during boot.
 */
const FATAL_RES = [
  /Failed to load/i,
  /No packs found/i,
  /Unable to open level/i,
  /\[Scripting\]\s*\[error\]/i,
];

export interface BdsServerOptions {
  serverDir: string;
  logFile: string;

  /** Echo BDS output to the terminal as it arrives. Off in tests; on for a human watching a run. */
  echo?: boolean;
}

/**
 * Owns a `bedrock_server` process: its stdin, its output, and its death.
 *
 * The output is consumed through a pipe rather than a shell redirect. That is not a style choice —
 * redirecting means nothing can react to a line as it arrives, so waiting for "Server started."
 * or for a run to go quiet becomes impossible, and a hung server can only be discovered by wall
 * clock.
 */
export class BdsServer {
  readonly #options: BdsServerOptions;
  readonly #events = new EventEmitter();
  readonly #tail: string[] = [];

  #child?: ChildProcessWithoutNullStreams;
  #log?: WriteStream;
  #transcript = '';
  #exited = false;
  #exitCode: number | null = null;
  #disposed = false;
  #lastLineAt = 0;
  #cleanup?: () => void;

  constructor(options: BdsServerOptions) {
    this.#options = options;
  }

  /** Everything the server has written so far, for the parser. */
  get transcript(): string {
    return this.#transcript;
  }

  get exited(): boolean {
    return this.#exited;
  }

  /** Milliseconds since the server last said anything — the basis for the idle timeout. */
  get idleMs(): number {
    return this.#lastLineAt === 0 ? 0 : Date.now() - this.#lastLineAt;
  }

  /** The last few lines, used to give a failure some context instead of a bare exit code. */
  tail(lines = 20): string[] {
    return this.#tail.slice(-lines);
  }

  async start(): Promise<void> {
    await fs.mkdir(path.dirname(this.#options.logFile), { recursive: true });
    this.#log = createWriteStream(this.#options.logFile, { flags: 'w' });

    const executable = process.platform === 'win32'
      ? path.join(this.#options.serverDir, serverExecutable())

      // The Linux build loads its bundled shared objects from the working directory, which only
      // works if it is invoked as a relative path with LD_LIBRARY_PATH pointing there.
      : `./${serverExecutable()}`;

    this.#child = spawn(executable, [], {
      cwd: this.#options.serverDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.platform === 'win32'
        ? process.env
        : { ...process.env, LD_LIBRARY_PATH: '.' },
    });

    this.#lastLineAt = Date.now();

    for (const stream of [this.#child.stdout, this.#child.stderr]) {
      createInterface({ input: stream }).on('line', line => this.#onLine(line));
    }

    this.#child.once('exit', (code) => {
      this.#exited = true;
      this.#exitCode = code;
      this.#events.emit('exit', code);
    });
    this.#child.once('error', error => this.#events.emit('failure', error));

    // A server that outlives the runner holds the world lock and the port, so the *next* run fails
    // for a reason that has nothing to do with the tests — and on Windows it sits there eating
    // 200 MB until someone notices.
    //
    // This kill is deliberately synchronous. Signal and `exit` handlers get no chance to await, so
    // asking politely (writing `stop` to stdin and waiting) is exactly what does not work here: the
    // runner is gone before the server acts on it. The graceful path lives in `stop()`, which the
    // normal flow always reaches; this is only for the abrupt ones.
    const cleanup = (): void => {
      if (this.#child && !this.#exited) { this.#child.kill('SIGKILL'); }
    };

    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
    process.once('SIGHUP', cleanup);
    process.once('exit', cleanup);

    this.#cleanup = (): void => {
      process.off('SIGINT', cleanup);
      process.off('SIGTERM', cleanup);
      process.off('SIGHUP', cleanup);
      process.off('exit', cleanup);
    };
  }

  #onLine(line: string): void {
    this.#lastLineAt = Date.now();
    this.#transcript += `${line}\n`;
    this.#log?.write(`${line}\n`);
    this.#tail.push(line);

    if (this.#tail.length > 200) { this.#tail.shift(); }

    if (this.#options.echo) { process.stdout.write(`  [2m${line}[0m\n`); }

    this.#events.emit('line', line);
  }

  /** Resolves when a line matches, rejects on a fatal line, server exit, or timeout. */
  waitForLine(match: RegExp, timeoutMs: number, what: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.#exited) {
        reject(new Error(`server exited (code ${this.#exitCode}) before ${what}`));

        return;
      }

      const done = (fn: () => void): void => {
        clearTimeout(timer);
        this.#events.off('line', onLine);
        this.#events.off('exit', onExit);
        fn();
      };

      const onLine = (line: string): void => {
        if (match.test(line)) { done(() => resolve(line)); } else if (FATAL_RES.some(re => re.test(line))) {
          done(() => reject(new Error(`server reported a fatal problem while waiting for ${what}:\n  ${line}`)));
        }
      };

      const onExit = (code: number | null): void => done(() => reject(new Error(`server exited (code ${code}) before ${what}`)));

      const timer = setTimeout(
        () => done(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${what}`))),
        timeoutMs,
      );

      this.#events.on('line', onLine);
      this.#events.once('exit', onExit);
    });
  }

  waitForReady(timeoutMs = 180_000): Promise<string> {
    return this.waitForLine(READY_RE, timeoutMs, 'the server to start');
  }

  /** Runs a console command. BDS reads its console from stdin, one command per line. */
  send(command: string): void {
    if (!this.#child || this.#exited) { throw new Error(`cannot send "${command}": the server is not running`); }

    this.#child.stdin.write(`${command}\n`);
  }

  /** Waits until the server has been quiet for `idleMs`, or `wallMs` elapses, or it exits. */
  async waitForQuiet(idleMs: number, wallMs: number): Promise<'quiet' | 'wall' | 'exit'> {
    const deadline = Date.now() + wallMs;

    for (;;) {
      if (this.#exited) { return 'exit'; }

      if (Date.now() >= deadline) { return 'wall'; }

      if (this.idleMs >= idleMs) { return 'quiet'; }

      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  /** Asks the server to stop, then escalates. Always resolves. */
  async stop(graceMs = 30_000): Promise<void> {
    if (!this.#child || this.#exited) { return; }

    const exited = new Promise<void>(resolve => this.#events.once('exit', () => resolve()));

    try {
      this.send('stop');
    } catch {
      // Already gone; the kill path below is a no-op.
    }

    const waitFor = async (ms: number): Promise<boolean> => Promise.race([exited.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), ms))]);

    if (await waitFor(graceMs)) { return; }

    this.#child.kill('SIGTERM');

    if (await waitFor(10_000)) { return; }

    this.#child.kill('SIGKILL');
    await waitFor(5_000);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) { return; }

    this.#disposed = true;

    await this.stop();
    this.#cleanup?.();
    this.#log?.end();
  }
}
