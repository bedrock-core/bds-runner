import { afterEach, expect, it, vi } from 'vitest';
import { connectDebugger } from '../debugger';

afterEach(() => { vi.useRealTimers(); });

it('keeps one native connection attempt pending until BDS acknowledges it', async () => {
  vi.useFakeTimers();
  let acknowledge!: (line: string) => void;
  const reply = new Promise<string>((resolve) => { acknowledge = resolve; });
  const server = { send: vi.fn(), waitForLine: vi.fn(() => reply) };
  const connection = connectDebugger(server, 19144, 10000);

  await vi.advanceTimersByTimeAsync(3000);
  expect(server.send).toHaveBeenCalledTimes(1);
  acknowledge('Debugger connected to host localhost on port 19144');
  await connection;
  expect(server.send).toHaveBeenCalledTimes(1);
});

it('retries after an explicit native failure and stops after connection', async () => {
  vi.useFakeTimers();
  const server = { send: vi.fn(), waitForLine: vi.fn()
    .mockResolvedValueOnce('Failed to start debugger')
    .mockResolvedValueOnce('Debugger connected to host localhost on port 19144') };
  const connection = connectDebugger(server, 19144, 10000);

  await vi.runAllTimersAsync();
  await connection;
  expect(server.send.mock.calls).toEqual([['script debugger connect localhost 19144'], ['script debugger connect localhost 19144']]);
});
