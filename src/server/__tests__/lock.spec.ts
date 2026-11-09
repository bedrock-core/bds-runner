import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { withInstanceLock } from '../lock';

it('locks one instance, releases failures, and reclaims an exited owner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-bds-lock-'));
  const main = path.join(root, 'server/main');

  expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(root).startsWith('bc-bds-lock-')).toBe(true);

  try {
    await withInstanceLock(main, async () => {
      await expect(withInstanceLock(main, async () => 0)).rejects.toThrow('busy');
      expect(await withInstanceLock(path.join(root, 'server/peer'), async () => 42)).toBe(42);
    });
    await expect(withInstanceLock(main, async () => { throw new Error('failure'); })).rejects.toThrow('failure');
    expect(await withInstanceLock(main, async () => true)).toBe(true);
    const exited = spawnSync(process.execPath, ['-e', '']);

    expect(exited.status).toBe(0);
    await fs.writeFile(path.join(root, 'server/.locks/main.json'), JSON.stringify({ pid: exited.pid }));
    expect(await withInstanceLock(main, async () => 'reclaimed')).toBe('reclaimed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
