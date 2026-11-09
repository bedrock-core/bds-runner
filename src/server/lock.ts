import fs from 'node:fs/promises';
import path from 'node:path';

/** The lock sits outside the executable tree so --fresh and build updates cannot remove it. */
export async function withInstanceLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
  const file = path.join(path.dirname(directory), '.locks', path.basename(directory) + '.json');

  await fs.mkdir(path.dirname(file), { recursive: true });
  let handle;

  for (;;) {
    try { handle = await fs.open(file, 'wx'); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }

      const owner = await fs.readFile(file, 'utf8').then((text) => {
        try { return JSON.parse(text) as { pid: number }; } catch { return undefined; }
      }, () => undefined);

      if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code === 'ESRCH') { await fs.unlink(file); continue; }
        }
      }

      throw new Error(`BDS instance is busy: ${directory}`, { cause: error });
    }
  }

  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));

    return await work();
  } finally {
    await handle.close();
    await fs.unlink(file);
  }
}
