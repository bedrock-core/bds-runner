import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const profiles = {
  server: { check: ['build:libs'], unit: ['test'], native: 'test:mc', fixtures: ['packages/test-fixtures/main', 'packages/test-fixtures/peer'] },
  ui: { check: ['build:libs'], unit: ['test:libs'], fixtures: [] },
  apps: { check: ['typecheck', 'build'], unit: ['test'], native: 'test:mc', fixtures: ['packages/test-fixtures'] },
};
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const versionParts = version => version.split('.').map(Number);

const compareVersions = (a, b) => {
  const left = versionParts(a);
  const right = versionParts(b);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);

    if (difference) { return difference; }
  }

  return 0;
};

export function manifestVersion(version) {
  const match = /^(\d+\.\d+\.\d+)(?:-(beta|rc)\..+)?$/.exec(version);

  assert(match, `Expected an exact SDK version, got ${version}`);

  return match[1] + (match[2] === 'beta' ? '-beta' : '');
}

/** Select the newest hotfix of each supported drop without letting Preview evict stable drops. */
export function createMatrix(catalog) {
  assert(Number.isInteger(catalog.major) && catalog.major > 0, 'major must be a positive integer');
  assert(Number.isInteger(catalog.minimumDrop) && catalog.minimumDrop >= 0, 'minimumDrop must be nonnegative');
  assert(catalog.stableDrops === 2 && catalog.previewDrops === 1, 'Support two stable drops and one Preview');
  assert(Array.isArray(catalog.releases), 'releases must be an array');

  const selected = [];

  for (const channel of ['stable', 'preview']) {
    const drops = new Map();

    for (const release of catalog.releases) {
      assert(/^1\.\d+\.\d+\.\d+$/.test(release.gameVersion), 'Use an exact four-part BDS version');
      assert(['stable', 'preview'].includes(release.gameChannel), 'Unknown game channel');

      const [, major, patch] = versionParts(release.gameVersion);
      const drop = Math.floor(patch / 10) * 10;

      if (major !== catalog.major || drop < catalog.minimumDrop || release.gameChannel !== channel) { continue; }

      const previous = drops.get(drop);

      if (!previous || compareVersions(release.gameVersion, previous.gameVersion) > 0) { drops.set(drop, release); }
    }

    const count = channel === 'stable' ? catalog.stableDrops : catalog.previewDrops;

    selected.push(...[...drops.entries()].sort(([a], [b]) => b - a).slice(0, count).map(([, release]) => release));
  }

  assert(selected.some(release => release.gameChannel === 'stable'), 'No supported stable releases');

  const include = selected.flatMap((release) => {
    const [, major, patch, build] = versionParts(release.gameVersion);
    const drop = Math.floor(patch / 10) * 10;
    const engineVersion = `1.${major}.${drop}`;
    const suffix = release.gameChannel === 'preview' ? `-preview.${build}` : '-stable';

    assert(release.vanillaData === engineVersion + (release.gameChannel === 'preview' ? suffix : ''), 'Vanilla data must match the game');
    assert(release.gameTest === `1.0.0-beta.${engineVersion}${suffix}`, 'GameTest SDK must match the game');
    assert(release.apis?.stable, 'Every game must include its stable API baseline');

    return Object.entries(release.apis).map(([apiChannel, sdk]) => {
      assert(['stable', 'rc', 'beta'].includes(apiChannel), 'Unknown API channel');

      for (const version of [sdk.server, sdk.serverUi]) {
        manifestVersion(version);
        assert(apiChannel === 'stable' ? /^\d+\.\d+\.\d+$/.test(version) : version.endsWith(`-${apiChannel}.${engineVersion}${suffix}`), 'SDK channel/build mismatch');
      }

      return {
        id: `${release.gameVersion}-${release.gameChannel}-${apiChannel}`,
        name: `Minecraft ${major}.${drop} / ${release.gameChannel} game / ${apiChannel} API`,
        gameVersion: release.gameVersion, gameChannel: release.gameChannel, apiChannel, engineVersion,
        packages: {
          '@minecraft/server': sdk.server,
          '@minecraft/server-ui': sdk.serverUi,
          '@minecraft/server-gametest': release.gameTest,
          '@minecraft/vanilla-data': release.vanillaData,
        },
      };
    });
  });

  include.push({ id: 'locked', name: 'Locked dependencies', apiChannel: 'locked' });

  return { include };
}

function profileFor(name) {
  assert(Object.hasOwn(profiles, name), `Unknown project profile: ${name}`);

  return profiles[name];
}

function statePath(root) {
  return path.join(root, '.bds/compatibility/result.json');
}

/** Sibling source aliases need the same workspace layout and SDKs as the project under test. */
export function sourcePeers(root, profileName) {
  profileFor(profileName);

  const inputs = ['package.json', 'tsconfig.json'].filter(file => existsSync(path.join(root, file)))
    .map(file => readFileSync(path.join(root, file), 'utf8')).join('\n');
  const ui = profileName === 'apps' && /(?:file:|portal:)?\.\.\/ui\//.test(inputs);
  const server = profileName !== 'server' && (ui || /(?:file:|portal:)?\.\.\/server\//.test(inputs));

  return { server, ui };
}

export function preparePeers(root, profileName, target, run = spawnSync, tooling = {}) {
  const peers = sourcePeers(root, profileName);

  for (const peer of ['server', 'ui'].filter(name => peers[name])) {
    const peerRoot = path.resolve(root, '..', peer);

    assert(existsSync(path.join(peerRoot, 'package.json')), `Missing sibling checkout: ${peer}`);
    prepareProject(peerRoot, peer, target, tooling);

    const result = run('corepack', ['yarn', 'install', target.id === 'locked' ? '--immutable' : '--no-immutable'], {
      cwd: peerRoot, stdio: 'inherit', shell: process.platform === 'win32',
      env: { ...process.env, YARN_ENABLE_IMMUTABLE_INSTALLS: target.id === 'locked' ? 'true' : 'false' },
    });

    assert.equal(result.status, 0, `Dependency installation failed for source peer ${peer}`);
  }
}

function visitJson(directory, callback) {
  if (!existsSync(directory)) { return; }

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory()) { visitJson(file, callback); } else if (entry.isFile() && entry.name.endsWith('.json')) { callback(file, entry.name); }
  }
}

/** Changes only the disposable CI checkout; pack identities and script entrypoints are retained. */
export function prepareProject(root, profileName, target, { builderPath } = {}) {
  const profile = profileFor(profileName);
  const state = { target, profile: profileName, stages: {}, nativeCoverage: profile.native ? 'not run' : 'no native suite', client: 'manual' };

  mkdirSync(path.dirname(statePath(root)), { recursive: true });
  writeJson(statePath(root), state);

  if (profile.native && builderPath) {
    const cli = path.resolve(root, builderPath, 'bin/builder.ts');
    const fixturePackage = path.join(root, 'packages/test-fixtures/package.json');

    assert(existsSync(cli), `Missing Builder source CLI: ${cli}`);

    const fixture = readJson(fixturePackage);
    const relative = path.relative(path.dirname(fixturePackage), cli).split(path.sep).join('/');
    const command = `node '${relative.replaceAll('\'', '\'\\\'\'')}'`;

    fixture.scripts = Object.fromEntries(Object.entries(fixture.scripts ?? {}).map(([name, script]) => [
      name, script.replace(/\bbc-builder(?=\s)/g, command),
    ]));
    writeJson(fixturePackage, fixture);
  }

  if (target.id === 'locked') { return; }

  const packagePath = path.join(root, 'package.json');
  const pkg = readJson(packagePath);

  pkg.resolutions = { ...pkg.resolutions, ...target.packages };

  if (profile.native) {
    // The tested runner source is checked out beside the project by the reusable workflow.
    pkg.resolutions['@bedrock-core/bds-runner'] = 'file:../bds-runner';
    pkg.devDependencies = { ...pkg.devDependencies, '@bedrock-core/bds-runner': 'file:../bds-runner' };
  }

  writeJson(packagePath, pkg);

  for (const fixture of profile.fixtures) {
    const fixtureRoot = path.join(root, fixture);
    const configPath = path.join(fixtureRoot, 'config.json');

    if (existsSync(configPath)) {
      const config = readJson(configPath);

      config.targetVersion = target.engineVersion;
      writeJson(configPath, config);
    }

    visitJson(path.join(fixtureRoot, 'packs'), (file, name) => {
      if (!/^manifest(?:\.[\w-]+)?\.json$/.test(name)) { return; }

      const manifest = readJson(file);

      if (manifest.header?.min_engine_version) {
        manifest.header.min_engine_version = Array.isArray(manifest.header.min_engine_version)
          ? versionParts(target.engineVersion)
          : target.engineVersion;
      }

      for (const dependency of manifest.dependencies ?? []) {
        if (Object.hasOwn(target.packages, dependency.module_name)) {
          dependency.version = manifestVersion(target.packages[dependency.module_name]);
        }
      }

      writeJson(file, manifest);
    });
  }
}

export function verifyNativeEvidence(report, target) {
  assert.equal(report.bdsVersion.replace(/^v/, ''), target.gameVersion, 'BDS result must match the requested build');
  assert.equal(report.infraError, null, 'BDS infrastructure failed');
  assert(Array.isArray(report.verdicts) && report.verdicts.length > 0, 'BDS reported no test verdicts');
  assert.deepEqual(report.regressions, [], 'Native test regressions');
  assert.deepEqual(report.scriptErrors, [], 'Uncaught Minecraft script errors');
}

export function runStage(root, profileName, target, stage, run = spawnSync) {
  const profile = profileFor(profileName);
  const state = readJson(statePath(root));

  if (stage === 'native' && (!profile.native || target.id === 'locked')) { return; }

  assert(['check', 'unit', 'native'].includes(stage), `Unknown stage: ${stage}`);

  const reportFile = '.bds/compatibility/native.json';
  const commands = stage === 'native'
    ? [[profile.native, '--bds-version', target.gameVersion, '--bds-channel', target.gameChannel, '--fresh', '--json', reportFile]]
    : profile[stage].map(script => [script]);

  try {
    for (const args of commands) {
      const env = { ...process.env };

      delete env.BC_BDS_PATH;
      delete env.BC_BDS_HOME;

      const result = run('corepack', ['yarn', ...args], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env });

      assert.equal(result.status, 0, `yarn ${args.join(' ')} failed${result.error ? `: ${result.error.message}` : ''}`);
    }

    if (stage === 'native') { verifyNativeEvidence(readJson(path.join(root, reportFile)), target); }

    state.stages[stage] = 'passed';
  } catch (error) {
    state.stages[stage] = 'failed';
    state.error = String(error.message);

    throw error;
  } finally {
    writeJson(statePath(root), state);
  }
}

export function formatReport(state) {
  const { target, stages } = state;
  const native = target.id === 'locked' ? 'not run (locked baseline)' : stages.native ?? state.nativeCoverage;

  return `### ${target.name}\n\n`
    + `Game build: ${target.gameVersion ?? 'repository lockfile'}; game channel: ${target.gameChannel ?? 'locked'}; API channel: ${target.apiChannel}.\n\n`
    + '| Check | Result |\n| --- | --- |\n'
    + `| Build / types | ${stages.check ?? 'not run'} |\n`
    + `| Unit tests | ${stages.unit ?? 'not run'} |\n`
    + `| BDS GameTests | ${native} |\n| Client checks | manual |\n\n`
    + (target.packages ? `SDK packages: \`${JSON.stringify(target.packages)}\`\n` : '');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, profileName, directory] = process.argv.slice(2);
  const catalog = readJson(fileURLToPath(new URL('../compatibility/targets.json', import.meta.url)));
  const matrix = createMatrix(catalog);

  if (command === 'matrix') {
    process.stdout.write(`${JSON.stringify(matrix)}\n`);
  } else {
    const root = path.resolve(directory ?? '.');
    const target = matrix.include.find(row => row.id === process.env.COMPATIBILITY_TARGET);

    assert(target, 'COMPATIBILITY_TARGET must identify a supported matrix row');
    profileFor(profileName);

    const tooling = { builderPath: process.env.COMPATIBILITY_BUILDER_PATH };

    if (command === 'peers') {
      const peers = sourcePeers(root, profileName);

      process.stdout.write(`server=${peers.server}\nui=${peers.ui}\n`);
    } else if (command === 'prepare-peers') { preparePeers(root, profileName, target, spawnSync, tooling); } else if (command === 'prepare') { prepareProject(root, profileName, target, tooling); } else if (command === 'report') {
      const state = existsSync(statePath(root)) ? readJson(statePath(root)) : { target, stages: {}, nativeCoverage: 'not run' };
      const report = formatReport(state);

      process.stdout.write(report);

      if (process.env.GITHUB_STEP_SUMMARY) { appendFileSync(process.env.GITHUB_STEP_SUMMARY, report); }
    } else { runStage(root, profileName, target, command); }
  }
}
