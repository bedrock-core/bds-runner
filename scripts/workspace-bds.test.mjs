import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { createPlan, applyPlan, linuxRules } from './workspace-bds.mjs';

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-bds-setup-test-'));

  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('bc-bds-setup-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });

  return root;
}

async function write(root, file, value) {
  const target = path.join(root, file);

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));

  return target;
}

test('preview discovers GameTest repositories, reserves distinct pairs and names future executables', async (t) => {
  const root = await workspace(t);
  const original = { version: '1.2.3.4', channel: 'preview', properties: { 'view-distance': 6 } };

  await write(root, 'server/bds-runner.json', original);
  await write(root, 'builder/package.json', { scripts: { 'acceptance:native': 'node scripts/acceptance.ts --native' } });
  await write(root, 'ui/package.json', { scripts: { test: 'vitest run' } });
  await write(root, 'builder-worktree/package.json', { scripts: { 'acceptance:native': 'node scripts/acceptance.ts --native' } });
  await write(root, 'builder-worktree/.git', 'gitdir: ../builder/.git/worktrees/temporary');
  const plan = await createPlan(root);

  assert.deepEqual(plan.projects.map(project => project.name), ['builder', 'server']);
  assert.deepEqual(plan.ports, [19780, 19781, 19782, 19783]);
  assert.equal(plan.projects[1].config.version, original.version);
  assert.equal(plan.projects[1].config.channel, 'preview');
  assert.deepEqual(plan.projects[1].config.properties, { 'view-distance': 6, 'server-ip': '127.0.0.1', 'enable-lan-visibility': false });
  assert.deepEqual(plan.projects[1].config.instances, { gametest: 19782 });
  assert(plan.rules.some(rule => rule.program === path.join(root, 'server/.bds/server/gametest/bedrock_server.exe')));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'server/bds-runner.json'), 'utf8')), original);
  await assert.rejects(fs.access(path.join(root, 'builder/bds-runner.json')));
  await assert.rejects(fs.access(path.join(root, 'server/.bds')));
});

test('existing instance assignments and executables are included, while caches and deeper files are excluded', async (t) => {
  const root = await workspace(t);

  await write(root, 'apps/bds-runner.json', { instance: 'config', instances: { config: 19800, standalone: 19802 } });
  await write(root, 'apps/.bds/server/older/bedrock_server.exe', 'marker');
  await write(root, 'apps/.bds/server/older/helper.exe', 'marker');
  await write(root, 'apps/.bds/server/older/subdir/ignored.exe', 'marker');
  await write(root, 'apps/.bds/cache/1.2.3.4/win32-x64/bedrock_server.exe', 'marker');
  const plan = await createPlan(root);

  assert.deepEqual(plan.ports, [19800, 19801, 19802, 19803]);
  assert.equal(plan.rules.length, 4);
  assert(!plan.rules.some(rule => rule.program.includes('cache') || rule.program.includes('ignored.exe')));
  assert.deepEqual((await createPlan(root)).rules, plan.rules);
});

test('overlapping assignments, invalid names, and exhausted port ranges are rejected', async (t) => {
  const root = await workspace(t);

  await write(root, 'a/bds-runner.json', { instance: 'main', instances: { main: 19780 } });
  await write(root, 'b/bds-runner.json', { instance: 'main', instances: { main: 19781 } });
  await assert.rejects(createPlan(root), /assigned to both/);
  await write(root, 'b/bds-runner.json', { instance: '../outside' });
  await assert.rejects(createPlan(root), /Invalid BDS instance/);
  await write(root, 'b/bds-runner.json', {});
  await assert.rejects(createPlan(root, { firstPort: 19780, lastPort: 19781 }), /no free pair/);
});

test('configuration is written only after the firewall command succeeds', async (t) => {
  const root = await workspace(t);

  await write(root, 'server/bds-runner.json', { version: '1.2.3.4' });
  const plan = await createPlan(root);
  let temporary;

  await assert.rejects(applyPlan(plan, { platform: 'win32', executeCommand(command, args) {
    assert.equal(command, 'powershell.exe');
    temporary = args.at(-1);
    throw new Error('permission denied');
  } }), /permission denied/);
  assert.deepEqual(JSON.parse(await fs.readFile(plan.projects[0].file, 'utf8')), { version: '1.2.3.4' });
  await assert.rejects(fs.access(temporary));
  let calls = 0;

  await applyPlan(plan, { platform: 'win32', executeCommand(command, args) {
    calls++;
    assert.equal(command, 'powershell.exe');
    assert(args.some(arg => arg.endsWith('workspace-firewall.ps1')));
    assert.equal(args.at(-2), '-Plan');
  } });
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(plan.projects[0].file, 'utf8')).instances, { gametest: 19780 });
});

test('Linux applies a checked, workspace-owned table without replacing global firewall policy', async (t) => {
  const root = await workspace(t);

  await write(root, 'server/bds-runner.json', {});
  const plan = await createPlan(root);
  const rules = linuxRules(plan);

  assert(rules.includes('iifname != "lo"'));
  assert(rules.includes('19780, 19781'));
  assert(rules.includes('policy accept'));
  assert(!rules.includes('flush ruleset'));
  const calls = [];

  await applyPlan(plan, { platform: 'linux', executeCommand(command, args, options) {
    calls.push({ command, args, input: options.input });
  } });
  assert.deepEqual(calls.map(call => call.args), [['-c', '-f', '-'], ['-f', '-']]);
  assert(calls.every(call => call.command === 'nft' && call.input === rules));
});
