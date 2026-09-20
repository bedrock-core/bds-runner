import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { discardWorld } from '../provision';

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
