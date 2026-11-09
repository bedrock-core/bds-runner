import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { discardWorld, provisionServer } from '../provision';

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) { await fs.rm(root, { recursive: true, force: true }); }
});

describe('discardWorld', () => {
  it('removes only the incomplete world', async () => {
    const server = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-provision-'));
    const incomplete = path.join(server, 'worlds', 'bc-test');
    const other = path.join(server, 'worlds', 'keep');

    roots.push(server);
    await fs.mkdir(incomplete, { recursive: true });
    await fs.writeFile(path.join(incomplete, 'level.dat'), 'partial');
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, 'level.dat'), 'keep');

    await discardWorld(incomplete);

    await expect(fs.access(incomplete)).rejects.toThrow();
    await expect(fs.readFile(path.join(other, 'level.dat'), 'utf8')).resolves.toBe('keep');
  });
});

describe('named instances', () => {
  it('reuses one executable path, refreshes changed builds, and leaves other instances intact', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-provision-'));

    roots.push(root);
    vi.stubEnv('BC_BDS_HOME', path.join(root, 'home'));

    try {
      const source = path.join(root, 'cache');
      const exe = process.platform === 'win32' ? 'bedrock_server.exe' : 'bedrock_server';

      await fs.mkdir(source);
      await fs.writeFile(path.join(source, exe), 'build one');
      const options = { cacheDir: source, version: '1.2.3.4', instance: 'main', levelName: 'test', port: 19780, watchdogHangMs: 60000 };
      const first = await provisionServer(options);

      expect(first.serverDir).toBe(path.join(root, 'home/server/main'));
      await fs.mkdir(first.worldDir, { recursive: true });
      await fs.writeFile(path.join(first.worldDir, 'level.dat'), 'world');
      const other = await provisionServer({ ...options, instance: 'other', port: 19782 });
      const before = await fs.stat(path.join(first.serverDir, exe));
      const reused = await provisionServer(options);

      expect(reused.created).toBe(false);
      expect((await fs.stat(path.join(reused.serverDir, exe))).mtimeMs).toBe(before.mtimeMs);
      await fs.writeFile(path.join(source, exe), 'build two');
      const updated = await provisionServer({ ...options, version: '2.3.4.5' });

      expect(updated.serverDir).toBe(first.serverDir);
      expect(updated.created).toBe(true);
      expect(await fs.readFile(path.join(updated.serverDir, exe), 'utf8')).toBe('build two');
      expect(await fs.readFile(path.join(other.serverDir, exe), 'utf8')).toBe('build one');
      await fs.writeFile(path.join(source, exe), 'changed override');
      await provisionServer({ ...options, version: '2.3.4.5' });
      expect(await fs.readFile(path.join(updated.serverDir, exe), 'utf8')).toBe('changed override');
      await expect(provisionServer({ ...options, cacheDir: updated.serverDir })).rejects.toThrow('outside');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
