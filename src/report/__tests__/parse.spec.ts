import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, describe, expect, it } from 'vitest';
import { parseReport, reconcile, summarise } from '../parse';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(path.join(here, 'fixtures', name), 'utf8');

/**
 * Captured from a real BDS 1.26.43.1 run of 16 gametests, playerless. Every expectation below is a
 * fact about the engine's output.
 */
const RUNSET = fixture('bds-runset-1.26.43.1.log');
const BOOT = fixture('bds-boot-experiments-1.26.43.1.log');

const KNOWN_FAILURE = 'bc:constructs:m3:lever_on_live_construct_toggles_thruster';

describe('report:parse', () => {
  it('reads the engine census from a real transcript', () => {
    const report = parseReport(RUNSET);

    expect(report.expected).toBe(16);
    expect(report.tag).toBe('bc:constructs:m3');
    expect(report.batches).toEqual(['bc:constructs:m3:0']);
  });

  it('accounts for every announced test', () => {
    const report = parseReport(RUNSET);

    expect(report.loaded).toHaveLength(16);
    expect(report.passed).toHaveLength(15);
    expect(report.failed).toHaveLength(1);
    // The roster and the census agree: nothing is unaccounted for.
    expect(report.loaded.length).toBe(report.expected);
    expect(report.passed.length + report.failed.length).toBe(report.expected);
  });

  it('captures the failure id and its full error text', () => {
    const report = parseReport(RUNSET);

    expect(report.failed[0].id).toBe(KNOWN_FAILURE);
    expect(report.failed[0].error).toBe(
      'GameTestError: powered thruster must lift the construct (v.y=-3.53)',
    );
  });

  it('reads the experiments BDS reported active at boot', () => {
    // This is the bootstrap tripwire: `Experiment(s) active: gtst` proves Beta APIs took effect.
    expect(parseReport(BOOT).experiments).toContain('gtst');
  });

  it('detects a tag that matched nothing', () => {
    expect(parseReport(BOOT).noTestsForTag).toBe('bc:nope');
  });

  it('ignores everything before the last run announcement', () => {
    // The console is one stream across every runset in a session. Results from an earlier run must
    // not leak into a later one.
    const stale = RUNSET.replace(/onTestPassed: (\S+)/g, 'onTestPassed: stale:$1');
    const report = parseReport(`${stale}\n${RUNSET}`);

    expect(report.passed).toHaveLength(15);
    assert.ok(
      report.passed.every(id => !id.startsWith('stale:')),
      'no verdict from the previous run may survive the anchor',
    );
  });

  it('tolerates log prefixes and bare lines alike', () => {
    // BDS prefixes some lines with `[ts INFO] ` and leaves onTest* bare; script output arrives as
    // `HH:MM:SS-[Scripting][Warning]-`. Matching anywhere in the line survives all three.
    const decorated = RUNSET.split('\n')
      .map(l => l.startsWith('onTest') ? `[2026-08-10 21:09:53:726 INFO] ${l}` : l)
      .join('\n');

    expect(parseReport(decorated).passed).toHaveLength(15);
  });
});

describe('report:reconcile', () => {
  it('produces one verdict per test, with the known failure named', () => {
    const verdicts = reconcile(parseReport(RUNSET));

    expect(verdicts).toHaveLength(16);
    expect(verdicts.filter(v => v.outcome === 'pass')).toHaveLength(15);

    const failures = verdicts.filter(v => v.outcome === 'fail');

    expect(failures).toHaveLength(1);
    expect(failures[0].id).toBe(KNOWN_FAILURE);
  });

  it('treats a loaded-but-unreported test as a failure, never a pass', () => {
    // maxTicks timeouts, unattributed throws and crashes all land here; every one is a failure.
    const truncated = RUNSET.replace(
      /onTestPassed: bc:constructs:m3:powered_bearing_drives_the_welded_rotor\n?/,
      '',
    );
    const verdicts = reconcile(parseReport(truncated));
    const orphan = verdicts.find(v => v.id.endsWith('powered_bearing_drives_the_welded_rotor'));

    expect(orphan?.outcome).toBe('fail');
    expect(orphan?.error).toMatch(/never reported a verdict/);
  });

  it('marks announced-but-never-loaded tests absent, not failed', () => {
    // A structural problem (missing .mcstructure, unplaceable plot) reads differently from a test
    // that ran and lost, and the message has to say which.
    const shortfall = parseReport(RUNSET.replace(/Running 16 tests/, 'Running 18 tests'));
    const verdicts = reconcile(shortfall);

    expect(verdicts).toHaveLength(18);
    expect(verdicts.filter(v => v.outcome === 'absent')).toHaveLength(2);
    expect(verdicts.find(v => v.outcome === 'absent')?.error).toMatch(/never loaded/);
  });
});

describe('report:summarise', () => {
  it('summarises the real run as 15 passed / 1 failed', () => {
    const summary = summarise(parseReport(RUNSET));

    expect(summary).toMatchObject({
      passed: 15,
      failed: 1,
      absent: 0,
      total: 16,
      expected: 16,
      tag: 'bc:constructs:m3',
      infraError: null,
    });
  });

  it('reports a renamed-log-lines engine as an infrastructure error, not a pass', () => {
    // If the engine renames these lines the result must be an infrastructure error, not a pass.
    const alien = RUNSET.replace(/onTest\w+:/g, 'somethingElse:')
      .replace(/Running 16 tests with tag '[^']*'/, '')
      .replace(/Running test batch '[^']*' \(16 tests\)/, '');
    const summary = summarise(parseReport(alien));

    expect(summary.passed).toBe(0);
    expect(summary.infraError).toMatch(/announced no test run/);
  });

  it('reports an unmatched tag as an infrastructure error', () => {
    expect(summarise(parseReport(BOOT)).infraError).toMatch(/no tests for tag 'bc:nope'/);
  });
});

describe('report:parse script errors', () => {
  const SCRIPT = fixture('bds-script-error-1.26.43.1.log');

  it('collects an uncaught exception the engine logged against a pack', () => {
    const errors = parseReport(SCRIPT).scriptErrors;

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('uncaught from a deferred callback');
    expect(errors[0]).toContain('[drav0011_economy.meta.name]');
  });

  it('ignores an error a pack chose to log itself', () => {
    // The same transcript has four deliberate console.error lines at the same level. Only an
    // uncaught exception opens with an Error class or carries a stack frame.
    const errors = parseReport(SCRIPT).scriptErrors;

    expect(errors.some(e => e.includes('collision: another instance'))).toBe(false);
  });

  it('does not fail the tests it appeared alongside', () => {
    const summary = summarise(parseReport(SCRIPT));

    expect(summary.passed).toBe(11);
    expect(summary.failed).toBe(0);
    // The verdicts are clean; it is the caller that decides this run is not green.
    expect(summary.infraError).toBeNull();
    expect(summary.scriptErrors).toHaveLength(1);
  });

  it('finds none in a transcript that had none', () => {
    expect(parseReport(RUNSET).scriptErrors).toEqual([]);
  });
});
