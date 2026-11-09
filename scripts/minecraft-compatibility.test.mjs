import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createMatrix, formatReport, manifestVersion, preparePeers, prepareProject, runStage, sourcePeers, verifyNativeEvidence } from './minecraft-compatibility.mjs';

const catalog = JSON.parse(readFileSync(new URL('./fixtures/compatibility-targets.json', import.meta.url), 'utf8'));
const matrix = createMatrix(catalog).include;
const target = matrix.find(row => row.gameChannel === 'preview' && row.apiChannel === 'beta');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

const writeJson = (file, data) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(data)); };

function project(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mc-compatibility-'));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJson(path.join(root, 'package.json'), { scripts: {}, resolutions: { unrelated: '1.0.0' } });

  return root;
}

test('the published target catalog produces a valid matrix', () => {
  const liveCatalog = JSON.parse(readFileSync(new URL('../compatibility/targets.json', import.meta.url), 'utf8'));

  assert(createMatrix(liveCatalog).include.some(row => row.apiChannel === 'stable'));
});

test('the catalog separates game channels from API tracks and retains the locked baseline', () => {
  assert.equal(matrix.length, 8);
  assert.deepEqual([...new Set(matrix.filter(row => row.gameChannel === 'stable').map(row => row.engineVersion))], ['1.26.60', '1.26.50']);
  assert.deepEqual(matrix.filter(row => row.gameChannel === 'preview').map(row => row.apiChannel), ['stable', 'rc', 'beta']);
  assert.equal(matrix.at(-1).id, 'locked');
});

test('a new stable drop evicts .50; hotfixes consume no additional support slots', () => {
  const updated = structuredClone(catalog);
  const release = structuredClone(updated.releases[1]);

  release.gameVersion = '1.26.70.6';
  release.vanillaData = '1.26.70';
  release.gameTest = '1.0.0-beta.1.26.70-stable';
  release.apis = { stable: { server: '2.12.0', serverUi: '2.4.0' } };
  updated.releases.push(release, { ...release, gameVersion: '1.26.71.1' });
  updated.releases.push({ ...release, gameVersion: '1.26.45.1' }, { ...release, gameVersion: '1.27.80.1' });

  const rows = createMatrix(updated).include;

  assert.deepEqual([...new Set(rows.filter(row => row.gameChannel === 'stable').map(row => row.gameVersion))], ['1.26.71.1', '1.26.61.1']);
  assert(rows.some(row => row.gameChannel === 'preview'));
  assert(!rows.some(row => ['1.26.50', '1.26.40', '1.27.80'].includes(row.engineVersion)));
});

test('only the latest Preview drop and build are selected', () => {
  const updated = structuredClone(catalog);
  const older = structuredClone(updated.releases[2]);

  older.gameVersion = '1.26.60.30';
  updated.releases.push(older, { ...older, gameVersion: '1.26.70.22' });
  assert.deepEqual([...new Set(createMatrix(updated).include.filter(row => row.gameChannel === 'preview').map(row => row.gameVersion))], ['1.26.70.23']);
});

test('rejects a Beta SDK from another game build and an unpinned SDK', () => {
  const invalid = structuredClone(catalog);

  invalid.releases[2].apis.beta.server = '2.13.0-beta.1.26.70-preview.22';
  assert.throws(() => createMatrix(invalid), /SDK channel\/build mismatch/);
  invalid.releases[2].apis.beta.server = 'latest';
  assert.throws(() => createMatrix(invalid), /exact SDK version/);
});

test('maps npm packages to native manifest versions', () => {
  assert.equal(manifestVersion('2.11.0'), '2.11.0');
  assert.equal(manifestVersion('2.12.0-rc.1.26.70-preview.23'), '2.12.0');
  assert.equal(manifestVersion('2.13.0-beta.1.26.70-preview.23'), '2.13.0-beta');
});

test('retargets fixture manifests and build targets while preserving pack identity and entrypoints', (t) => {
  const root = project(t);
  const fixture = path.join(root, 'packages/test-fixtures');
  const manifest = {
    header: { uuid: 'pack-id', min_engine_version: [1, 26, 50] },
    modules: [{ type: 'script', entry: 'scripts/gametest.js', uuid: 'module-id' }],
    dependencies: [{ module_name: '@minecraft/server', version: '2.10.0' }, { uuid: 'peer', version: '1.0.0' }],
  };

  writeJson(path.join(fixture, 'config.json'), { targetVersion: '1.26.50', packs: { behaviorPack: './packs/BP' } });
  writeJson(path.join(fixture, 'packs/BP/manifest.json'), manifest);
  writeJson(path.join(fixture, 'packs/BP/manifest.test.json'), { extends: './manifest.json', dependencies: [{ module_name: '@minecraft/server-gametest', version: 'old' }] });
  writeJson(path.join(root, 'unrelated/manifest.json'), manifest);
  prepareProject(root, 'apps', target);

  const selected = readJson(path.join(fixture, 'packs/BP/manifest.json'));

  assert.equal(selected.header.uuid, 'pack-id');
  assert.deepEqual(selected.header.min_engine_version, [1, 26, 70]);
  assert.deepEqual(selected.modules, manifest.modules);
  assert.deepEqual(selected.dependencies[1], manifest.dependencies[1]);
  assert.equal(selected.dependencies[0].version, '2.13.0-beta');
  assert.equal(readJson(path.join(fixture, 'packs/BP/manifest.test.json')).dependencies[0].version, '1.0.0-beta');
  assert.equal(readJson(path.join(fixture, 'config.json')).targetVersion, '1.26.70');
  assert.deepEqual(readJson(path.join(root, 'unrelated/manifest.json')), manifest);
  assert.equal(readJson(path.join(root, 'package.json')).resolutions.unrelated, '1.0.0');
});

test('the locked baseline changes no dependencies or fixture files', (t) => {
  const root = project(t);
  const before = readFileSync(path.join(root, 'package.json'), 'utf8');

  prepareProject(root, 'apps', matrix.at(-1));
  assert.equal(readFileSync(path.join(root, 'package.json'), 'utf8'), before);
});

test('registry dependencies need no siblings; source aliases and file resolutions preserve their workspace layout', (t) => {
  const root = project(t);

  assert.deepEqual(sourcePeers(root, 'apps'), { server: false, ui: false });
  writeJson(path.join(root, 'tsconfig.json'), { compilerOptions: { paths: { '@bedrock-core/db': ['../server/packages/db/src/index.ts'] } } });
  assert.deepEqual(sourcePeers(root, 'ui'), { server: true, ui: false });
  writeJson(path.join(root, 'package.json'), { resolutions: { '@bedrock-core/ui-runtime': 'file:../ui/packages/ui-runtime' } });
  assert.deepEqual(sourcePeers(root, 'apps'), { server: true, ui: true });
  assert.deepEqual(sourcePeers(root, 'server'), { server: false, ui: false });
});

test('source peers install the selected SDK before the consumer', (t) => {
  const workspace = project(t);
  const root = path.join(workspace, 'apps');

  writeJson(path.join(root, 'package.json'), { resolutions: { '@bedrock-core/ui-runtime': 'file:../ui/packages/ui-runtime' } });

  for (const peer of ['server', 'ui']) { writeJson(path.join(workspace, peer, 'package.json'), { resolutions: {} }); }

  const installed = [];

  preparePeers(root, 'apps', target, (command, args, options) => {
    installed.push(path.basename(options.cwd));
    assert.equal(readJson(path.join(options.cwd, 'package.json')).resolutions['@minecraft/server'], target.packages['@minecraft/server']);
    assert.deepEqual(args, ['yarn', 'install', '--no-immutable']);

    return { status: 0 };
  });
  assert.deepEqual(installed, ['server', 'ui']);
});

const evidence = { bdsVersion: target.gameVersion, verdicts: [{ id: 'fixture:test', outcome: 'pass' }], regressions: [], scriptErrors: [], infraError: null };

test('native fixtures can use adjacent Builder source without changing the locked dependencies', (t) => {
  const workspace = project(t);
  const root = path.join(workspace, 'apps');
  const packageFile = path.join(root, 'package.json');
  const fixtureFile = path.join(root, 'packages/test-fixtures/package.json');

  writeJson(packageFile, { resolutions: { '@bedrock-core/builder': '0.1.2' } });
  writeJson(path.join(workspace, 'builder/bin/builder.ts'), {});
  writeJson(fixtureFile, { scripts: { build: 'bc-builder build config.json test', typecheck: 'tsc --noEmit' } });
  prepareProject(root, 'apps', matrix.at(-1), { builderPath: '../builder' });

  assert.deepEqual(readJson(packageFile), { resolutions: { '@bedrock-core/builder': '0.1.2' } });
  assert.equal(readJson(fixtureFile).scripts.build, 'node \'../../../builder/bin/builder.ts\' build config.json test');
  assert.equal(readJson(fixtureFile).scripts.typecheck, 'tsc --noEmit');
});

test('native evidence requires the exact build, verdicts, no regressions and no script/infrastructure errors', () => {
  verifyNativeEvidence(evidence, target);

  for (const changed of [
    { bdsVersion: '1.26.60.30' }, { verdicts: [] }, { regressions: ['fixture:test'] },
    { scriptErrors: ['ReferenceError'] }, { infraError: 'missing tests' },
  ]) { assert.throws(() => verifyNativeEvidence({ ...evidence, ...changed }, target)); }
});

test('native execution uses the existing test:mc script with explicit build/channel and a fresh world', (t) => {
  const root = project(t);

  prepareProject(root, 'server', target);
  writeJson(path.join(root, '.bds/compatibility/native.json'), evidence);
  runStage(root, 'server', target, 'native', (executable, args, options) => {
    assert.equal(executable, 'corepack');
    assert.deepEqual(args, ['yarn', 'test:mc', '--bds-version', target.gameVersion, '--bds-channel', 'preview', '--fresh', '--json', '.bds/compatibility/native.json']);
    assert.equal(options.env.BC_BDS_PATH, undefined);

    return { status: 0 };
  });
  assert.equal(readJson(path.join(root, '.bds/compatibility/result.json')).stages.native, 'passed');
});

test('a failed type check does not suppress independently invoked unit tests', (t) => {
  const root = project(t);

  prepareProject(root, 'apps', target);
  assert.throws(() => runStage(root, 'apps', target, 'check', () => ({ status: 1 })), /failed/);
  runStage(root, 'apps', target, 'unit', () => ({ status: 0 }));

  const state = readJson(path.join(root, '.bds/compatibility/result.json'));

  assert.deepEqual(state.stages, { check: 'failed', unit: 'passed' });
  assert.match(formatReport(state), /BDS GameTests \| not run/);
});

test('UI reports its native coverage gap and manual client checks', (t) => {
  const root = project(t);

  prepareProject(root, 'ui', target);
  runStage(root, 'ui', target, 'native', () => { throw new Error('UI has no native suite'); });

  const report = formatReport(readJson(path.join(root, '.bds/compatibility/result.json')));

  assert.match(report, /no native suite/);
  assert.match(report, /Client checks \| manual/);
});
