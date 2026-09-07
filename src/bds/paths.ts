import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Marks the consumer's project root when no config file is committed. */
const PROJECT_MARKERS = ['package.json', '.git'];

/** The config file a project may commit: which build to run and any server property overrides. */
export const CONFIG_FILE = 'bds-runner.json';

/** Used when no flag, environment variable or config file names a build. */
const DEFAULTS = { version: 'latest', channel: 'stable' as const };

function findUp(name: string, from: string): string | undefined {
  let dir = path.resolve(from);

  for (;;) {
    if (existsSync(path.join(dir, name))) { return dir; }

    const parent = path.dirname(dir);

    if (parent === dir) { return undefined; }

    dir = parent;
  }
}

/**
 * Where the server cache and logs go: the directory holding the nearest config file, else the
 * nearest `package.json` or `.git`, else the working directory.
 */
export function projectRoot(from: string = process.cwd()): string {
  const config = findConfig(from);

  if (config) { return path.dirname(config); }

  for (const marker of PROJECT_MARKERS) {
    const found = findUp(marker, from);

    if (found) { return found; }
  }

  return path.resolve(from);
}

/** `<project>/.bds` unless `BC_BDS_HOME` says otherwise (CI caches, or a drive with room). */
export function bdsHome(): string {
  return process.env.BC_BDS_HOME
    ? path.resolve(process.env.BC_BDS_HOME)
    : path.join(projectRoot(), '.bds');
}

/** Extracted server builds, one per version and platform. Runs use a copy; see `serverDir`. */
export function cacheDir(version: string, platform = platformKey()): string {
  return path.join(bdsHome(), 'cache', version, platform);
}

/** The tree the server runs in: a copy of the cache, kept across runs of the same version. */
export function serverDir(version: string): string {
  return path.join(bdsHome(), 'server', version);
}

export function logsDir(): string {
  return path.join(bdsHome(), 'logs');
}

/** The JSON Schema for the config file, regenerated from the selected server on every resolve. */
export function schemaFile(): string {
  return path.join(bdsHome(), 'schema', CONFIG_FILE);
}

export function platformKey(): 'win32-x64' | 'linux-x64' {
  if (process.platform === 'win32') { return 'win32-x64'; }

  if (process.platform === 'linux') { return 'linux-x64'; }

  throw new Error(
    `Bedrock Dedicated Server is published for Windows and Linux only; this is ${process.platform}. `
    + 'Run the in-game tests on one of those, or point BC_BDS_PATH at a server you manage yourself.',
  );
}

export function serverExecutable(): string {
  return process.platform === 'win32' ? 'bedrock_server.exe' : 'bedrock_server';
}

export interface PinnedVersion {
  /** An exact build, or `latest` to take whatever the channel currently points at. */
  version: string;

  /** Which BDS-Versions tree the build is looked up in. */
  channel: 'stable' | 'preview';
}

/** The project's config file, resolved against flags and environment. */
export interface RunnerConfig extends PinnedVersion {
  /** `server.properties` overrides. Keys and types come from the selected server; see `schemaFile`. */
  properties: Record<string, string | number | boolean>;
}

/** Overrides for a single run, from a CLI flag. Both accept the same values as the config file. */
export interface VersionOverride {
  version?: string;
  channel?: 'stable' | 'preview';
  configPath?: string;
}

function asChannel(raw: unknown, source: string): 'stable' | 'preview' | undefined {
  if (raw === undefined || raw === null) { return undefined; }

  if (raw !== 'stable' && raw !== 'preview') {
    throw new Error(`${source} must be "stable" or "preview", got ${JSON.stringify(raw)}`);
  }

  return raw;
}

/** The config file nearest the working directory, or `undefined` when the project commits none. */
export function findConfig(from: string = process.cwd()): string | undefined {
  const dir = findUp(CONFIG_FILE, from);

  return dir ? path.join(dir, CONFIG_FILE) : undefined;
}

function asProperties(raw: unknown, source: string): Record<string, string | number | boolean> {
  if (raw === undefined || raw === null) { return {}; }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${source} must be an object of server.properties keys`);
  }

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error(`${source}: "${key}" must be a string, number or boolean`);
    }
  }

  return raw as Record<string, string | number | boolean>;
}

function readConfig(file: string): Partial<RunnerConfig> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new Error(`${file} is not valid JSON`, { cause });
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${file} must contain a JSON object`);
  }

  const { version, channel, properties } = parsed as Record<string, unknown>;

  if (version !== undefined && typeof version !== 'string') {
    throw new Error(`${file}: "version" must be a string`);
  }

  return {
    version,
    channel: asChannel(channel, `${file}: "channel"`),
    properties: asProperties(properties, `${file}: "properties"`),
  };
}

/**
 * The effective config. Build selection is CLI flag, then environment, then the config file, then
 * `latest` stable; server property overrides come from the config file alone.
 */
export function loadConfig(override: VersionOverride = {}): RunnerConfig {
  const file = override.configPath ?? findConfig();
  const config = file ? readConfig(file) : {};

  return {
    version: override.version
      ?? process.env.BC_BDS_VERSION
      ?? config.version
      ?? DEFAULTS.version,
    channel: override.channel
      ?? asChannel(process.env.BC_BDS_CHANNEL, 'BC_BDS_CHANNEL')
      ?? config.channel
      ?? DEFAULTS.channel,
    properties: config.properties ?? {},
  };
}

/** Which build to run. See `loadConfig`. */
export function pinnedVersion(override: VersionOverride = {}): PinnedVersion {
  const { version, channel } = loadConfig(override);

  return { version, channel };
}
