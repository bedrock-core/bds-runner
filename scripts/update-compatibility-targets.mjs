import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createMatrix } from './minecraft-compatibility.mjs';

const bdsUrl = 'https://raw.githubusercontent.com/Bedrock-OSS/BDS-Versions/main/versions.json';
const samplesApi = 'https://api.github.com/repos/Mojang/bedrock-samples';
const packageNames = {
  server: '@minecraft/server',
  serverUi: '@minecraft/server-ui',
  gameTest: '@minecraft/server-gametest',
  vanillaData: '@minecraft/vanilla-data',
};
const parts = version => version.split('.').map(Number);

const compare = (a, b) => {
  const left = parts(a);
  const right = parts(b);

  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference) { return difference; }
  }

  return 0;
};

const dropOf = version => Math.floor(parts(version)[2] / 10) * 10;
const keyOf = release => `${release.gameChannel}:${dropOf(release.gameVersion)}`;
const published = (metadata, version) => metadata.versions[version]?.version === version;
const latest = versions => versions.sort(compare).at(-1);

function withinPolicy(version, catalog) {
  assert(/^1\.\d+\.\d+\.\d+$/.test(version), `Invalid upstream BDS version: ${version}`);

  return parts(version)[1] === catalog.major && dropOf(version) >= catalog.minimumDrop;
}

/** BDS must be available on both runner platforms before becoming a target. */
export function releaseCandidates(catalog, bds) {
  const releases = [];
  const pending = [];

  for (const gameChannel of ['stable', 'preview']) {
    const field = gameChannel === 'stable' ? 'versions' : 'preview_versions';
    const count = gameChannel === 'stable' ? catalog.stableDrops : catalog.previewDrops;
    const pinned = [...new Set(catalog.releases.filter(release => release.gameChannel === gameChannel
      && withinPolicy(release.gameVersion, catalog)).map(release => dropOf(release.gameVersion)))].sort((a, b) => b - a).slice(0, count);
    const minimumDrop = pinned.length === count ? pinned.at(-1) : catalog.minimumDrop;
    const platforms = ['linux', 'windows'].map((platform) => {
      assert(Array.isArray(bds[platform]?.[field]), `BDS index is missing ${platform}.${field}`);

      return bds[platform][field].filter(version => withinPolicy(version, catalog) && dropOf(version) >= minimumDrop);
    });
    const drops = new Map();

    for (const gameVersion of new Set(platforms.flat())) {
      const release = { gameVersion, gameChannel };
      const previous = drops.get(dropOf(gameVersion));

      if (!previous || compare(gameVersion, previous.gameVersion) > 0) { drops.set(dropOf(gameVersion), release); }
    }

    for (const release of drops.values()) {
      if (platforms.every(versions => versions.includes(release.gameVersion))) { releases.push(release); } else {
        pending.push(`${release.gameChannel} ${release.gameVersion}: waiting for both Linux and Windows BDS builds`);
      }
    }
  }

  return { releases, pending };
}

export function sampleReleases(refs, catalog) {
  assert(Array.isArray(refs), 'Mojang sample references must be an array');

  return refs.flatMap((entry) => {
    const match = /^refs\/tags\/v(1\.\d+\.\d+\.\d+)(-preview)?$/.exec(entry.ref);

    if (!match || !withinPolicy(match[1], catalog)) { return []; }

    return [{ gameVersion: match[1], gameChannel: match[2] ? 'preview' : 'stable', ref: entry.ref.slice('refs/tags/'.length) }];
  });
}

function sampleFor(release, samples) {
  return samples.filter(sample => sample.gameChannel === release.gameChannel
    && (release.gameChannel === 'preview'
      ? sample.gameVersion === release.gameVersion
      : dropOf(sample.gameVersion) === dropOf(release.gameVersion)
        && parts(sample.gameVersion)[2] === dropOf(release.gameVersion)
        && compare(sample.gameVersion, release.gameVersion) <= 0))
    .sort((a, b) => compare(a.gameVersion, b.gameVersion)).at(-1);
}

function sdkFor(name, modules, metadata, suffix) {
  const native = modules.flatMap((entry) => {
    const match = new RegExp(`^${name}_(\\d+\\.\\d+\\.\\d+)(?:-(beta|rc))?\\.json$`).exec(entry.name);

    return match ? [{ version: match[1], channel: match[2] ?? 'stable' }] : [];
  });
  const rc = native.filter(entry => entry.channel === 'rc'
    || (entry.channel === 'stable' && published(metadata, `${entry.version}-rc.${suffix}`)));
  const stable = latest(native.filter(entry => entry.channel === 'stable'
    && !rc.some(candidate => candidate.version === entry.version)).map(entry => entry.version));
  const beta = latest(native.filter(entry => entry.channel === 'beta').map(entry => entry.version));
  const candidate = {
    stable,
    ...(rc.length ? { rc: `${latest(rc.map(entry => entry.version))}-rc.${suffix}` } : {}),
    ...(beta ? { beta: `${beta}-beta.${suffix}` } : {}),
  };

  assert(stable, `Mojang metadata has no stable @minecraft/${name} module`);

  for (const version of Object.values(candidate)) {
    assert(published(metadata, version), `waiting for @minecraft/${name}@${version} on npm`);
  }

  return candidate;
}

/** Derive API baselines from Mojang's tagged modules, never from API version arithmetic. */
function completeRelease(release, sample, packages) {
  assert(sample?.modules, 'waiting for matching Mojang tagged Script API metadata');
  assert(Array.isArray(sample.modules) && sample.modules.every(entry => typeof entry.name === 'string'), 'Invalid Mojang module directory');

  const [, major, , build] = parts(release.gameVersion);
  const engineVersion = `1.${major}.${dropOf(release.gameVersion)}`;
  const suffix = `${engineVersion}${release.gameChannel === 'preview' ? `-preview.${build}` : '-stable'}`;
  const vanillaData = engineVersion + (release.gameChannel === 'preview' ? `-preview.${build}` : '');
  const gameTest = `1.0.0-beta.${suffix}`;

  assert(published(packages.vanillaData, vanillaData), `waiting for @minecraft/vanilla-data@${vanillaData} on npm`);
  assert(published(packages.gameTest, gameTest), `waiting for @minecraft/server-gametest@${gameTest} on npm`);

  const server = sdkFor('server', sample.modules, packages.server, suffix);
  const serverUi = sdkFor('server-ui', sample.modules, packages.serverUi, suffix);
  const apis = {};

  for (const channel of ['stable', 'rc', 'beta']) {
    assert(Boolean(server[channel]) === Boolean(serverUi[channel]), `waiting for a complete ${channel} server/server-ui API pair`);

    if (server[channel]) { apis[channel] = { server: server[channel], serverUi: serverUi[channel] }; }
  }

  return { ...release, vanillaData, gameTest, apis };
}

export function refreshCatalog(catalog, { bds, samples, packages }) {
  createMatrix(catalog);

  for (const [key, name] of Object.entries(packageNames)) {
    assert(packages[key]?.name === name && packages[key]?.versions && typeof packages[key].versions === 'object', `Invalid npm metadata for ${name}`);
  }

  const { releases, pending } = releaseCandidates(catalog, bds);
  const selected = new Map();
  const sources = [];

  for (const release of catalog.releases) {
    if (!withinPolicy(release.gameVersion, catalog)) { continue; }

    const previous = selected.get(keyOf(release));

    if (!previous || compare(release.gameVersion, previous.gameVersion) > 0) { selected.set(keyOf(release), release); }
  }

  for (const release of releases) {
    const previous = selected.get(keyOf(release));

    if (previous && compare(release.gameVersion, previous.gameVersion) < 0) {
      pending.push(`${release.gameChannel} ${release.gameVersion}: upstream BDS index is behind pinned ${previous.gameVersion}`);
      continue;
    }

    try {
      const sample = sampleFor(release, samples);
      const complete = completeRelease(release, sample, packages);

      if (previous) {
        for (const name of ['server', 'serverUi']) {
          assert(compare(complete.apis.stable[name], previous.apis.stable[name]) >= 0, `Mojang metadata is behind pinned stable ${name} API`);
        }

        if (compare(release.gameVersion, previous.gameVersion) === 0) {
          assert(Object.keys(previous.apis).every(channel => complete.apis[channel]), 'waiting for all pinned API tracks');
        }
      }

      selected.set(keyOf(release), complete);
      sources.push(`https://github.com/Mojang/bedrock-samples/tree/${sample.ref}/metadata/script_modules/%40minecraft`);
    } catch (error) {
      pending.push(`${release.gameChannel} ${release.gameVersion}: ${error.message}`);
    }
  }

  const updated = {
    ...catalog,
    releases: ['stable', 'preview'].flatMap(channel => [...selected.values()]
      .filter(release => release.gameChannel === channel)
      .sort((a, b) => compare(b.gameVersion, a.gameVersion))
      .slice(0, channel === 'stable' ? catalog.stableDrops : catalog.previewDrops).reverse()),
  };

  createMatrix(updated);

  return { catalog: updated, changed: JSON.stringify(updated) !== JSON.stringify(catalog), pending, sources: [...new Set(sources)] };
}

export async function fetchMetadata(catalog, { fetchImpl = fetch, githubToken } = {}) {
  const json = async (url, allowMissing = false) => {
    const headers = { accept: 'application/json' };

    if (githubToken && new URL(url).origin === 'https://api.github.com') { headers.authorization = `Bearer ${githubToken}`; }

    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });

    if (allowMissing && response.status === 404) { return null; }

    assert(response.ok, `GET ${url} returned HTTP ${response.status}`);

    return response.json();
  };

  const [bds, refs, packageEntries] = await Promise.all([
    json(bdsUrl),
    json(`${samplesApi}/git/matching-refs/tags/v1.${catalog.major}.`),
    Promise.all(Object.entries(packageNames).map(async ([key, name]) => [key, await json(`https://registry.npmjs.org/${name}`)])),
  ]);
  const samples = sampleReleases(refs, catalog);
  const needed = [...new Set(releaseCandidates(catalog, bds).releases.map(release => sampleFor(release, samples)).filter(Boolean))];

  await Promise.all(needed.map(async (sample) => {
    sample.modules = await json(`${samplesApi}/contents/metadata/script_modules/%40minecraft?ref=${encodeURIComponent(sample.ref)}`, true);
  }));

  return { bds, samples, packages: Object.fromEntries(packageEntries) };
}

export function formatSummary(result) {
  return `## Minecraft compatibility targets\n\n${result.changed ? 'Complete releases update the target catalog.' : 'The target catalog is unchanged.'}\n\n`
    + '| Game channel | BDS build | Stable server API | Stable server-ui API |\n| --- | --- | --- | --- |\n'
    + result.catalog.releases.map(release => `| ${release.gameChannel} | ${release.gameVersion} | ${release.apis.stable.server} | ${release.apis.stable.serverUi} |\n`).join('')
    + (result.pending.length ? `\n### Waiting for upstream metadata\n\n${result.pending.map(message => `- ${message}`).join('\n')}\n` : '')
    + '\nSources: [BDS build index](https://github.com/Bedrock-OSS/BDS-Versions), [official Minecraft npm packages](https://www.npmjs.com/org/minecraft)'
    + result.sources.map(url => `, [Mojang tagged API modules](${url})`).join('')
    + '.\n\nValidation checks the catalog and generated matrix; it does not run Minecraft. Merge this change to activate these pins in consumers.\n';
}

export async function updateTargets({ catalogPath, write = false, summaryPath, fetchImpl, githubToken } = {}) {
  const file = catalogPath ?? fileURLToPath(new URL('../compatibility/targets.json', import.meta.url));
  const catalog = JSON.parse(readFileSync(file, 'utf8'));

  createMatrix(catalog);

  const result = refreshCatalog(catalog, await fetchMetadata(catalog, { fetchImpl, githubToken }));

  if (write && result.changed) { writeFileSync(file, `${JSON.stringify(result.catalog, null, 2)}\n`); }

  if (summaryPath) { writeFileSync(summaryPath, formatSummary(result)); }

  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { write: { type: 'boolean', default: false }, catalog: { type: 'string' }, summary: { type: 'string' } } });
  const result = await updateTargets({ catalogPath: values.catalog, write: values.write, summaryPath: values.summary, githubToken: process.env.GH_TOKEN });
  const summary = formatSummary(result);

  process.stdout.write(summary);

  if (process.env.GITHUB_STEP_SUMMARY) { appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary); }
}
