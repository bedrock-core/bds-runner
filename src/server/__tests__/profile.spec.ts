import fs from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ScriptProfiler } from '../profile';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();

  for (const root of roots.splice(0)) { await fs.rm(root, { recursive: true, force: true }); }
});

it('copies native CPU and diagnostics captures while preserving existing captures', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-script-profile-O\'Brien-'));

  roots.push(root);
  vi.stubEnv('APPDATA', path.join(root, 'appdata'));
  const logs = path.join(root, 'server', 'logs');

  await fs.mkdir(logs, { recursive: true });
  await fs.writeFile(path.join(logs, 'existing.cpuprofile'), 'keep');
  const commands: string[] = [];
  let transcript = '';
  const server = { exited: false, get transcript(): string { return transcript; }, send(command: string): void {
    commands.push(command);

    if (command === 'script profiler stop') {
      writeFileSync(path.join(logs, 'new.cpuprofile'), '{"nodes":[]}');
      writeFileSync(path.join(logs, 'concurrent.cpuprofile'), 'another server');
      transcript += `Profiler stopped. Profile saved to '${path.join(logs, 'new.cpuprofile')}'\n`;
    }

    if (command === 'script diagnostics stopcapture') {
      const folder = path.join(process.env.APPDATA!, 'Minecraft Bedrock Server', 'logs', 'diagnostics');

      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, 'new.mcstats'), '{"encoding":"base64-gzip"}');
      transcript += `Diagnostics capture stopped - saved to '${path.join(folder, 'new.mcstats')}'\n`;
    }
  } };
  const profiler = new ScriptProfiler(server, path.join(root, 'server'), path.join(root, 'evidence'));

  await profiler.start();
  const result = await profiler.stop();

  expect(commands).toEqual(['script profiler start', 'script diagnostics startcapture', 'script profiler stop', 'script diagnostics stopcapture']);
  expect(result.cpuProfiles).toHaveLength(1);
  expect(result.diagnostics).toHaveLength(1);
  expect(await fs.readFile(path.join(logs, 'existing.cpuprofile'), 'utf8')).toBe('keep');
  expect(await fs.readFile(result.cpuProfiles[0], 'utf8')).toBe('{"nodes":[]}');
  expect(JSON.parse(await fs.readFile(path.join(result.directory, 'captures.json'), 'utf8'))).toEqual(result);
});

it('rejects a second start while a capture is active', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-script-profile-'));

  roots.push(root);
  vi.stubEnv('APPDATA', path.join(root, 'appdata'));
  const profiler = new ScriptProfiler({ exited: false, transcript: '', send(): void {} }, root, path.join(root, 'evidence'));

  await profiler.start();
  await expect(profiler.start()).rejects.toThrow('already active');
});

it('rejects a native capture outside the server log directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-script-profile-'));

  roots.push(root);
  let transcript = '';
  const server = { exited: false, get transcript(): string { return transcript; }, send(command: string): void {
    if (command === 'script profiler stop') { transcript += `Profiler stopped. Profile saved to '${path.join(root, 'outside.cpuprofile')}'\n`; }
  } };
  const profiler = new ScriptProfiler(server, path.join(root, 'server'), path.join(root, 'evidence'));

  await profiler.start();
  await expect(profiler.stop()).rejects.toThrow('outside the server');
});
