import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fetchMetadata, formatSummary, refreshCatalog, updateTargets } from './update-compatibility-targets.mjs';
import { createMatrix } from './minecraft-compatibility.mjs';

const catalog = JSON.parse(readFileSync(new URL('./fixtures/compatibility-targets.json', import.meta.url), 'utf8'));
const names = { server: '@minecraft/server', serverUi: '@minecraft/server-ui', gameTest: '@minecraft/server-gametest', vanillaData: '@minecraft/vanilla-data' };

const addVersion = (metadata, version) => { metadata.versions[version] = { version }; };

function metadata() {
  const packages = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, { name, versions: {} }]));
  const samples = catalog.releases.map((release) => {
    addVersion(packages.vanillaData, release.vanillaData);
    addVersion(packages.gameTest, release.gameTest);

    const modules = [];

    for (const [channel, sdk] of Object.entries(release.apis)) {
      for (const key of ['server', 'serverUi']) {
        addVersion(packages[key], sdk[key]);
        modules.push({ name: `${key === 'server' ? 'server' : 'server-ui'}_${sdk[key].split('-')[0]}${channel === 'beta' ? '-beta' : ''}.json` });
      }
    }

    const gameVersion = release.gameChannel === 'stable' ? `${release.vanillaData}.1` : release.gameVersion;

    return { gameVersion, gameChannel: release.gameChannel, ref: `v${gameVersion}${release.gameChannel === 'preview' ? '-preview' : ''}`, modules };
  });
  const platform = {
    versions: catalog.releases.filter(release => release.gameChannel === 'stable').map(release => release.gameVersion),
    preview_versions: catalog.releases.filter(release => release.gameChannel === 'preview').map(release => release.gameVersion),
  };

  return { packages, samples, bds: { linux: structuredClone(platform), windows: structuredClone(platform) } };
}

function addBds(data, version, channel = 'stable', platforms = ['linux', 'windows']) {
  for (const platform of platforms) { data.bds[platform][channel === 'preview' ? 'preview_versions' : 'versions'].push(version); }
}

function newDrop(data) {
  addBds(data, '1.26.80.5');
  data.samples.push({
    gameVersion: '1.26.80.5', gameChannel: 'stable', ref: 'v1.26.80.5',
    modules: ['server_2.14.0.json', 'server_2.18.0-beta.json', 'server-ui_2.7.0.json', 'server-ui_2.11.0-beta.json'].map(name => ({ name })),
  });
  addVersion(data.packages.vanillaData, '1.26.80');
  addVersion(data.packages.gameTest, '1.0.0-beta.1.26.80-stable');
  addVersion(data.packages.server, '2.14.0');
  addVersion(data.packages.serverUi, '2.7.0');
  addVersion(data.packages.server, '2.18.0-beta.1.26.80-stable');
  addVersion(data.packages.serverUi, '2.11.0-beta.1.26.80-stable');
}

test('matching metadata preserves all exact pins and is idempotent', () => {
  const result = refreshCatalog(catalog, metadata());

  assert.deepEqual(result.catalog, catalog);
  assert.equal(result.changed, false);
  assert.deepEqual(result.pending, []);
  assert.equal(createMatrix(result.catalog).include.length, 8);
});

test('the latest hotfix updates BDS without inventing hotfix SDK versions', () => {
  const data = metadata();

  addBds(data, '1.26.63.1');
  addBds(data, '1.26.62.1');

  const result = refreshCatalog(catalog, data);
  const release = result.catalog.releases.find(row => row.gameVersion === '1.26.63.1');

  assert(release);
  assert.deepEqual(release.apis, catalog.releases[1].apis);
  assert.equal(release.vanillaData, '1.26.60');
  assert.equal(release.gameTest, '1.0.0-beta.1.26.60-stable');
  assert.equal(result.catalog.releases.length, 3);
  assert.equal(refreshCatalog(result.catalog, data).changed, false);
});

test('a complete new drop evicts the oldest stable drop using Mojang module versions', () => {
  const data = metadata();

  newDrop(data);
  addVersion(data.packages.server, '9.0.0');
  addVersion(data.packages.serverUi, '8.0.0');

  const result = refreshCatalog(catalog, data);
  const release = result.catalog.releases.find(row => row.gameVersion === '1.26.80.5');

  assert.deepEqual(result.catalog.releases.filter(row => row.gameChannel === 'stable').map(row => row.gameVersion), ['1.26.61.1', '1.26.80.5']);
  assert.deepEqual(release.apis.stable, { server: '2.14.0', serverUi: '2.7.0' });
  assert.equal(release.apis.beta.server, '2.18.0-beta.1.26.80-stable');
  assert(result.catalog.releases.some(row => row.gameChannel === 'preview'));
  assert.equal(createMatrix(result.catalog).include.length, 8);
});

test('missing vanilla data, GameTest, stable SDK or Beta SDK leaves existing targets intact', async (t) => {
  for (const [key, version] of [['vanillaData', '1.26.80'], ['gameTest', '1.0.0-beta.1.26.80-stable'], ['server', '2.14.0'], ['serverUi', '2.11.0-beta.1.26.80-stable']]) {
    await t.test(`${key}@${version}`, () => {
      const data = metadata();

      newDrop(data);
      delete data.packages[key].versions[version];

      const result = refreshCatalog(catalog, data);

      assert.deepEqual(result.catalog, catalog);
      assert(result.pending.some(message => message.includes(version)));
    });
  }
});

test('a Preview needs the exact tagged build and a complete matching API pair', () => {
  const data = metadata();

  addBds(data, '1.26.70.24', 'preview');

  let result = refreshCatalog(catalog, data);

  assert.deepEqual(result.catalog, catalog);
  assert(result.pending.some(message => /70\.24.*tagged/.test(message)));
  data.samples.push({ ...structuredClone(data.samples.at(-1)), gameVersion: '1.26.70.24', ref: 'v1.26.70.24-preview' });
  addVersion(data.packages.vanillaData, '1.26.70-preview.24');
  addVersion(data.packages.gameTest, '1.0.0-beta.1.26.70-preview.24');

  for (const key of ['server', 'serverUi']) {
    for (const version of Object.keys(data.packages[key].versions).filter(version => version.endsWith('preview.23'))) {
      addVersion(data.packages[key], version.replace('preview.23', 'preview.24'));
    }
  }

  result = refreshCatalog(catalog, data);
  assert.equal(result.catalog.releases.at(-1).gameVersion, '1.26.70.24');
  assert.equal(result.catalog.releases.at(-1).apis.rc.server, '2.12.0-rc.1.26.70-preview.24');
  delete data.packages.serverUi.versions['2.4.0-rc.1.26.70-preview.24'];
  result = refreshCatalog(catalog, data);
  assert.deepEqual(result.catalog, catalog);
  assert(result.pending.some(message => message.includes('2.4.0')));
});

test('a build published for only one platform waits rather than rolling back the pin', () => {
  const data = metadata();

  addBds(data, '1.26.63.1', 'stable', ['windows']);

  const result = refreshCatalog(catalog, data);

  assert.deepEqual(result.catalog, catalog);
  assert(result.pending.some(message => /63\.1.*Linux and Windows/.test(message)));
});

test('stale BDS metadata and missing pinned npm tracks cannot downgrade targets', () => {
  const data = metadata();

  for (const platform of ['linux', 'windows']) { data.bds[platform].versions = ['1.26.50.1', '1.26.60.1']; }

  let result = refreshCatalog(catalog, data);

  assert.deepEqual(result.catalog, catalog);
  assert(result.pending.filter(message => message.includes('behind pinned')).length === 2);
  delete data.packages.server.versions[catalog.releases[2].apis.beta.server];
  result = refreshCatalog(catalog, data);
  assert.deepEqual(result.catalog, catalog);
  assert(result.pending.some(message => message.includes('2.13.0-beta')));
});

test('a stale Mojang module listing cannot lower an existing stable API baseline', () => {
  const data = metadata();
  const sample = data.samples.find(row => row.ref === 'v1.26.60.1');

  sample.modules = sample.modules.filter(entry => entry.name !== 'server_2.11.0.json');
  sample.modules.push({ name: 'server_2.10.0.json' });

  const result = refreshCatalog(catalog, data);

  assert.deepEqual(result.catalog, catalog);
  assert(result.pending.some(message => message.includes('behind pinned stable')));
});

test('retired Preview drops do not fetch or report irrelevant missing metadata', async () => {
  const data = metadata();
  const calls = [];

  addBds(data, '1.26.60.30', 'preview');
  data.samples.push({ gameVersion: '1.26.60.30', gameChannel: 'preview', ref: 'v1.26.60.30-preview' });

  const fetched = await fetchMetadata(catalog, { fetchImpl: mockFetch(data, calls) });
  const result = refreshCatalog(catalog, fetched);

  assert(!calls.some(call => call.url.includes('ref=v1.26.60.30-preview')));
  assert.deepEqual(result.pending, []);
});

test('support major, minimum drop and drop counts stay explicit', () => {
  const data = metadata();

  addBds(data, '1.27.10.1');
  addBds(data, '1.26.40.1');

  const result = refreshCatalog(catalog, data);

  assert.deepEqual(result.catalog, catalog);
  assert.equal(result.catalog.major, 26);
  assert.equal(result.catalog.minimumDrop, 50);
  assert.equal(result.catalog.stableDrops, 2);
  assert.equal(result.catalog.previewDrops, 1);
});

test('invalid upstream schemas fail before writing', () => {
  const data = metadata();

  delete data.bds.linux.versions;
  assert.throws(() => refreshCatalog(catalog, data), /BDS index is missing/);
  data.bds.linux.versions = [];
  data.packages.server.name = 'unexpected-package';
  assert.throws(() => refreshCatalog(catalog, data), /Invalid npm metadata/);
});

function mockFetch(data, calls = [], failure) {
  return async (url, options) => {
    calls.push({ url, options });

    if (failure?.(url)) { return { ok: false, status: 503 }; }

    let body;

    if (url.includes('BDS-Versions')) { body = data.bds; } else if (url.includes('/git/matching-refs/')) {
      body = data.samples.map(sample => ({ ref: `refs/tags/${sample.ref}` }));
    } else if (url.includes('/contents/')) {
      body = data.samples.find(sample => sample.ref === new URL(url).searchParams.get('ref'))?.modules;
    } else { body = Object.values(data.packages).find(pkg => url.endsWith(pkg.name)); }

    return { ok: Boolean(body), status: body ? 200 : 404, json: async () => structuredClone(body) };
  };
}

test('fetching authenticates only GitHub and fetches only selected tagged metadata', async () => {
  const data = metadata();
  const calls = [];
  const result = await fetchMetadata(catalog, { fetchImpl: mockFetch(data, calls), githubToken: 'test-token' });

  assert.equal(calls.length, 9);
  assert.equal(result.samples.filter(sample => sample.modules).length, 3);

  for (const { url, options } of calls) {
    assert.equal(options.headers.authorization, new URL(url).hostname === 'api.github.com' ? 'Bearer test-token' : undefined);
    assert(options.signal instanceof AbortSignal);
  }
});

test('dry runs are read-only; writes happen only for a validated complete change', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bc-target-updater-'));
  const catalogPath = path.join(root, 'targets.json');
  const summaryPath = path.join(root, 'summary.md');
  const original = `${JSON.stringify(catalog, null, 2)}\n`;
  const data = metadata();

  t.after(() => {
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('bc-target-updater-'));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(catalogPath, original);
  newDrop(data);

  const result = await updateTargets({ catalogPath, summaryPath, fetchImpl: mockFetch(data) });

  assert.equal(readFileSync(catalogPath, 'utf8'), original);
  assert(readFileSync(summaryPath, 'utf8').includes('1.26.80.5'));
  assert.equal(result.changed, true);
  await assert.rejects(updateTargets({ catalogPath, write: true, fetchImpl: mockFetch(data, [], url => url.includes('/server-ui')) }), /HTTP 503/);
  assert.equal(readFileSync(catalogPath, 'utf8'), original);
  await updateTargets({ catalogPath, write: true, fetchImpl: mockFetch(data) });
  assert.equal(JSON.parse(readFileSync(catalogPath, 'utf8')).releases[1].gameVersion, '1.26.80.5');
});

test('the review summary identifies incomplete releases and exact metadata sources', () => {
  const data = metadata();

  addBds(data, '1.26.70.24', 'preview');

  const summary = formatSummary(refreshCatalog(catalog, data));

  assert(summary.includes('Waiting for upstream metadata'));
  assert(summary.includes('1.26.70.24'));
  assert(summary.includes('github.com/Mojang/bedrock-samples/tree/v1.26.60.1/metadata/'));
  assert(summary.includes('does not run Minecraft'));
});
