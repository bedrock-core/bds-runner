import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const repository = fileURLToPath(new URL('../', import.meta.url));
const jiti = createJiti(import.meta.url);
const { optimizePacks } = await jiti.import('../src/index.ts');
const modern = process.argv[2] ?? '1.26.70.23';
const legacy = process.argv[3] ?? '1.26.60.30';
const base = path.join(repository, '.bds/optimizer-acceptance');

await fs.mkdir(base, { recursive: true });
const root = await fs.mkdtemp(path.join(base, 'verified-'));
const input = path.join(root, 'input');
const fixtures = [
  { name: 'behavior to example', type: 'data', uuid: '0b50eef0-c5cc-4e46-a0af-c6b170ebfa8f',
    module: '90571950-cc41-47fd-a09a-c29ac8fd744c', file: 'recipes/example.json',
    content: { 'format_version': '1.20.10', 'minecraft:recipe_shapeless': {
      description: { identifier: 'fixture:sample' }, tags: ['crafting_table'],
      ingredients: [{ item: 'minecraft:stone' }], result: { item: 'minecraft:cobblestone', count: 1 },
    } } },
  { name: 'resources', type: 'resources', uuid: 'd2e438f3-0743-4099-a91a-200d30cc0ce8',
    module: 'a6ed526b-2325-4491-b70a-bff0bc63aa1f', file: 'models/entity/example.geo.json',
    content: { 'format_version': '1.12.0', 'minecraft:geometry': [{
      description: { identifier: 'geometry.fixture', texture_width: 16, texture_height: 16 },
      bones: [{ name: 'root', pivot: [0, 0, 0], cubes: [{ origin: [0, 0, 0], size: [1, 1, 1], uv: [0, 0] }] }],
    }] } },
];

for (const fixture of fixtures) {
  const dir = path.join(input, fixture.name);

  await fs.mkdir(path.join(dir, path.dirname(fixture.file)), { recursive: true });
  await fs.mkdir(path.join(dir, 'texts'), { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    format_version: 2,
    header: { name: fixture.name, description: 'PackOptimizer fixture', uuid: fixture.uuid,
      version: [1, 0, 0], min_engine_version: [1, 26, 40] },
    modules: [{ type: fixture.type, uuid: fixture.module, version: [1, 0, 0] }],
  }, null, 2));
  await fs.writeFile(path.join(dir, fixture.file), JSON.stringify(fixture.content, null, 2));
  await fs.writeFile(path.join(dir, 'texts/en_US.lang'), 'fixture.name=Optimizer\n');
}

async function inventory(dir) {
  const result = [];

  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      for (const item of await inventory(file)) { result.push({ ...item, path: `${entry.name}/${item.path}` }); }
    } else {
      const bytes = await fs.readFile(file);

      result.push({ path: entry.name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }

  return result.sort((a, b) => a.path.localeCompare(b.path));
}

const cases = [];

async function convert(name, packsDir, version, options, expected) {
  const outDir = path.join(root, name);
  const before = await inventory(packsDir);
  const logs = [];
  const result = await optimizePacks({ packsDir, outDir, bdsVersion: version,
    bdsChannel: 'preview', offline: true, echo: true,
    onProgress: message => logs.push(message), ...options });

  assert.equal(result.mode, expected);
  assert.equal(result.unpacked, expected === 'unpacked');
  assert.equal(result.packs.length, fixtures.length);
  assert.deepEqual(await inventory(packsDir), before, 'conversion changed its inputs');

  for (const pack of result.packs) {
    const fixture = fixtures.find(item => item.name === pack.name);

    assert(fixture, `unexpected pack ${pack.name}`);
    assert.equal(pack.mode, expected);
    assert.equal(pack.sizeBefore, (await inventory(path.join(packsDir, pack.name))).reduce((sum, file) => sum + file.bytes, 0));
    assert.equal(pack.sizeAfter, (await inventory(path.join(outDir, pack.name))).reduce((sum, file) => sum + file.bytes, 0));
    assert(pack.sizeAfter > 0);

    if (expected !== 'brpak') {
      const manifest = JSON.parse(await fs.readFile(path.join(outDir, pack.name, 'manifest.json'), 'utf8'));

      assert.equal(manifest.header.uuid, fixture.uuid);
      assert.equal(manifest.modules[0].type, fixture.type);
    }

    if (expected === 'unpacked') {
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(outDir, pack.name, fixture.file), 'utf8')), fixture.content);
      assert.equal(await fs.readFile(path.join(outDir, pack.name, 'texts/en_US.lang'), 'utf8'), 'fixture.name=Optimizer\n');
    }
  }

  const files = await inventory(outDir);

  if (expected === 'brpak') { assert(files.every(file => file.path.endsWith('.brpak'))); }

  if (expected === 'brarchive') { assert(files.some(file => file.path.endsWith('.brarchive'))); }

  if (expected === 'unpacked') { assert(!files.some(file => /\.(?:brarchive|brpak)$/.test(file.path))); }

  await fs.writeFile(path.join(root, `${name}.log`), `${logs.join('\n')}\n`);
  cases.push({ name, version, expected, result, files });
  console.info(`PASS ${name}: ${result.packs.length} packs, ${expected}`);

  return outDir;
}

const sources = new Map([['unpacked', input]]);

for (const mode of ['brpak', 'brarchive', 'unpacked']) {
  const output = await convert(`modern-unpacked-to-${mode}`, input, modern, { mode }, mode);

  sources.set(mode, output);
}

for (const from of ['brpak', 'brarchive']) {
  for (const mode of ['brpak', 'brarchive', 'unpacked']) {
    const name = `modern-${from}-to-${mode}`;

    try {
      await convert(name, sources.get(from), modern, { mode }, mode);
    } catch (error) {
      if (modern !== '1.26.70.23' || mode !== 'brarchive'
        || !/wrote unpacked.*expected brarchive/.test(error.message)) { throw error; }

      const files = await inventory(path.join(root, name));

      assert(!files.some(file => /\.(?:brarchive|brpak)$/.test(file.path)));
      cases.push({ name, version: modern, expected: 'reject native output format mismatch', error: error.message, files });
      console.info(`PASS ${name}: rejected native output format mismatch`);
    }
  }
}

await convert('modern-default', input, modern, {}, 'brpak');
const unpacked = await convert('modern-unpack-alias', sources.get('brpak'), modern, { unpack: true }, 'unpacked');

await convert('modern-brpak-via-unpacked-to-brarchive', unpacked, modern, { mode: 'brarchive' }, 'brarchive');
const archived = await convert('legacy-default', input, legacy, {}, 'brarchive');

await convert('legacy-explicit-brarchive', input, legacy, { mode: 'brarchive' }, 'brarchive');
await convert('legacy-unpack-alias', archived, legacy, { unpack: true }, 'unpacked');
await convert('legacy-explicit-unpacked', archived, legacy, { mode: 'unpacked' }, 'unpacked');

const outDir = path.join(root, 'unsupported-format');
const sentinel = path.join(outDir, fixtures[0].name, 'keep.txt');

await fs.mkdir(path.dirname(sentinel), { recursive: true });
await fs.writeFile(sentinel, 'unchanged');
await assert.rejects(optimizePacks({ packsDir: input, outDir, bdsVersion: legacy,
  bdsChannel: 'preview', offline: true, mode: 'brpak' }), /does not support brpak/);
assert.equal(await fs.readFile(sentinel, 'utf8'), 'unchanged');
cases.push({ name: 'legacy-unsupported-brpak', version: legacy, expected: 'rejected without clearing output' });

const sourceHashes = {};

for (const file of ['src/bds/optimize.ts', 'src/cli.ts', 'src/index.ts', 'scripts/optimizer-acceptance.mjs']) {
  sourceHashes[file] = createHash('sha256').update(await fs.readFile(path.join(repository, file))).digest('hex');
}

const report = path.join(root, 'acceptance.json');

await fs.writeFile(report, `${JSON.stringify({ kind: 'native-pack-optimizer', modern, legacy,
  sourceHashes, cases, passed: cases.length }, null, 2)}\n`);
console.info(`PASS ${cases.length} native checks; report: ${report}`);
