import { describe, expect, it } from 'vitest';
import { testSelection } from '../test-selection';
import { testEvents } from '../../report/events';
import { summariseSelection } from '../../report/selection';
import { runGameTests } from '../../run';

describe('IDE test selection and verdicts', () => {
  it('selects an individual test, tagged suite or default set', () => {
    expect(testSelection({ test: 'example:one' }).command).toBe('gametest run example:one');
    expect(testSelection({ tag: 'example' }).command).toBe('gametest runset example');
    expect(testSelection({ all: true }).command).toBe('gametest runset');
  });
  it('rejects ambiguous selection and console injection', () => {
    expect(() => testSelection({})).toThrow('exactly one');
    expect(() => testSelection({ tag: 'a', test: 'a:b' })).toThrow('exactly one');
    expect(() => testSelection({ test: 'a:b\nstop' })).toThrow('console syntax');
    expect(() => testSelection({ test: '' })).toThrow('console syntax');
  });
  it('cancels before inspecting packs or starting a server', async () => {
    const controller = new AbortController(), reason = new Error('Cancelled before startup');

    controller.abort(reason);

    await expect(runGameTests({ test: 'example:one', packsDirs: '/no-pack-is-read', signal: controller.signal })).rejects.toBe(reason);
  });
  it('preserves native test identity and failure text in IDE events', () => {
    expect(testEvents('onTestStructureLoaded: example:one')).toEqual([{ type: 'test.started', id: 'example:one' }]);
    expect(testEvents('onTestPassed: example:one')).toEqual([{ type: 'test.passed', id: 'example:one' }]);
    expect(testEvents('onTestFailed: example:two - expected solid ground')).toEqual([{ type: 'test.failed', id: 'example:two', error: 'expected solid ground' }]);
  });
  it('retains earlier verdicts across selected invocations and detects absent requested tests', () => {
    const first = 'onTestStructureLoaded: example:one\nonTestPassed: example:one';
    const second = 'onTestStructureLoaded: example:two\nonTestFailed: example:two - wrong block';
    const summary = summariseSelection(first + '\n' + second, [first, second], ['example:one', 'example:two', 'example:missing']);

    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.absent).toBe(1);
    expect(summary.expected).toBeNull();
    expect(summary.infraError).toContain('no native verdict');
  });
});
