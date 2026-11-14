import type { BdsServer } from './process';

/** Native connection attempts must finish before another attempt is queued. */
export async function connectDebugger(server: Pick<BdsServer, 'send' | 'waitForLine'>, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const remaining = deadline - Date.now();

    if (remaining <= 0) { throw new Error('Timed out waiting for the Minecraft debugger to connect'); }

    const reply = server.waitForLine(/debugger connected to host|failed to start debugger/i, remaining, 'the Minecraft debugger to connect');

    server.send(`script debugger connect localhost ${port}`);
    const line = await reply;

    if (/debugger connected to host/i.test(line)) { return; }

    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
