/**
 * Parses a Bedrock Dedicated Server transcript into gametest verdicts.
 *
 * The engine emits its own structured accounting, observed verbatim on BDS 1.26.43.1:
 *
 * ```
 * Running test batch 'bc:constructs:m3:0' (16 tests)...
 * [2026-08-10 21:09:53:726 INFO] Running 16 tests with tag 'bc:constructs:m3'...
 * onTestStructureLoaded: bc:constructs:m3:weld_splits_hinged_machine_and_arm_swings
 * onTestPassed: bc:constructs:m3:pickcell_resolves_the_aimed_construct_cell
 * onTestFailed: bc:constructs:m3:lever_on_live_construct_toggles_thruster - GameTestError: powered thruster must lift the construct (v.y=-3.53)
 * ```
 *
 * Two properties make reading it sound even though Mojang documents none of these strings:
 *
 *  - the **expected count and the verdicts come from the same channel**, so a format change breaks
 *    both at once rather than one of them;
 *  - **anything announced but unaccounted for is a failure**, never a pass.
 *
 * Together those mean a future engine that renames these lines produces a loud "0 of N accounted"
 * infrastructure error. The failure mode is a red build, never a false green — which is the only
 * property that actually matters when the strings are a private interface.
 *
 * There is deliberately no completion line to wait for: the engine prints nothing when a run ends,
 * so completion is `accounted === expected` plus the idle/wall timeouts in the caller.
 */

/** Announced expectation: `Running 16 tests with tag 'bc:constructs:m3'...` */
const EXPECTED_RE = /Running\s+(\d+)\s+tests?\s+with\s+tag\s+'([^']*)'/;

/** Batch announcement: `Running test batch 'bc:constructs:m3:0' (16 tests)...` */
const BATCH_RE = /Running test batch\s+'([^']*)'\s+\((\d+)\s+tests?\)/;

/** `onTestStructureLoaded: <id>` — the test's plot was placed, so it is about to run. */
const LOADED_RE = /onTestStructureLoaded:\s*(\S+)/;

/** `onTestPassed: <id>` */
const PASSED_RE = /onTestPassed:\s*(\S+)/;

/** `onTestFailed: <id> - <error>` — the separator is ` - ` and the error may contain anything. */
const FAILED_RE = /onTestFailed:\s*(\S+)\s+-\s+([\s\S]*)$/;

/** `[ERROR] No tests found for tag 'bc:nope'` — a tag typo, not a test failure. */
const NO_TESTS_RE = /No tests found for tag\s+'([^']*)'/;

/** BDS confirms enabled experiments at boot: `Experiment(s) active: gtst`. */
const EXPERIMENTS_RE = /Experiment\(s\) active:\s*(.+?)\s*$/;

/**
 * A run is bounded by the batch/expected announcement. BDS appends to one console stream across
 * every `runset` issued in a session, so without anchoring to the *last* announcement a second run
 * would inherit the first one's verdicts — and a renamed or deleted test would haunt the results
 * forever. Everything before the last announcement belongs to a previous run.
 */
export const RUN_ANCHOR_RE = new RegExp(`${BATCH_RE.source}|${EXPECTED_RE.source}`);

export type Outcome = 'pass' | 'fail' | 'absent' | 'unobservable';

export interface Verdict {
  id: string;
  outcome: Outcome;
  error?: string;
}

export interface Report {

  /** How many tests the engine said it would run, or `null` if it never said. */
  expected: number | null;
  tag: string | null;
  batches: string[];
  loaded: string[];
  passed: string[];
  failed: { id: string; error: string }[];

  /** Set when the engine reported the tag matched nothing at all. */
  noTestsForTag: string | null;

  /** Experiments BDS reported active at boot, e.g. `['gtst']`. */
  experiments: string[];
}

const EMPTY: Report = {
  expected: null,
  tag: null,
  batches: [],
  loaded: [],
  passed: [],
  failed: [],
  noTestsForTag: null,
  experiments: [],
};

/**
 * Reads a transcript into a `Report`, considering only the most recent run.
 *
 * Lines are matched *anywhere* in the string rather than anchored: BDS prefixes some output with
 * `[YYYY-MM-DD HH:MM:SS:mmm INFO] ` and leaves the `onTest*` lines bare, and script output arrives
 * as `HH:MM:SS-[Scripting][Warning]-`. Matching loosely costs nothing and survives that
 * inconsistency.
 */
export function parseReport(text: string): Report {
  const lines = text.split(/\r?\n/);

  // Experiments are announced during boot, i.e. *before* the run anchor, so collect them first
  // across the whole transcript.
  const experiments: string[] = [];

  for (const line of lines) {
    const m = EXPERIMENTS_RE.exec(line);

    if (m) { experiments.push(...m[1].split(/[,\s]+/).filter(Boolean)); }
  }

  // Anchor on the last run announcement; everything before it belongs to a previous run.
  //
  // The engine announces a run as a *cluster* — one `Running test batch …` line per batch, then the
  // `Running N tests with tag …` census — so anchoring on the census alone would slice the batch
  // lines off the front of the very run they describe. Find the census, then walk back over the
  // announcement lines (and the blanks between them) that belong to it. The walk stops at the first
  // line that is neither, which in a multi-run stream is the previous run's last verdict.
  let start = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    if (!EXPECTED_RE.test(lines[i]) && !BATCH_RE.test(lines[i])) { continue; }

    start = i;

    while (start > 0) {
      const previous = lines[start - 1];

      if (previous.trim() === '' || BATCH_RE.test(previous)) { start--; } else { break; }
    }

    break;
  }

  const report: Report = { ...EMPTY, experiments, batches: [], loaded: [], passed: [], failed: [] };

  for (const line of lines.slice(start)) {
    const batch = BATCH_RE.exec(line);

    if (batch) {
      if (!report.batches.includes(batch[1])) { report.batches.push(batch[1]); }

      continue;
    }

    const expected = EXPECTED_RE.exec(line);

    if (expected) {
      report.expected = Number(expected[1]);
      report.tag = expected[2];
      continue;
    }

    const loaded = LOADED_RE.exec(line);

    if (loaded) {
      if (!report.loaded.includes(loaded[1])) { report.loaded.push(loaded[1]); }

      continue;
    }

    const passed = PASSED_RE.exec(line);

    if (passed) {
      if (!report.passed.includes(passed[1])) { report.passed.push(passed[1]); }

      continue;
    }

    const failed = FAILED_RE.exec(line);

    if (failed) {
      if (!report.failed.some(f => f.id === failed[1])) {
        report.failed.push({ id: failed[1], error: failed[2].trim() });
      }

      continue;
    }

    const none = NO_TESTS_RE.exec(line);

    if (none) { report.noTestsForTag = none[1]; }
  }

  return report;
}

/**
 * Turns a `Report` into one verdict per test.
 *
 * The engine names every test it loads, so `loaded` is the roster. A test that was loaded but has
 * no verdict did not quietly pass — it hit `maxTicks`, threw where the engine could not attribute
 * it, or took the server down with it — so it is a **failure**, not a gap in our knowledge. That
 * inference is the single load-bearing rule here.
 */
export function reconcile(report: Report): Verdict[] {
  const verdicts: Verdict[] = [];
  const failedById = new Map(report.failed.map(f => [f.id, f.error]));

  for (const id of report.loaded) {
    if (failedById.has(id)) {
      verdicts.push({ id, outcome: 'fail', error: failedById.get(id) });
    } else if (report.passed.includes(id)) {
      verdicts.push({ id, outcome: 'pass' });
    } else {
      verdicts.push({
        id,
        outcome: 'fail',
        error: 'loaded but never reported a verdict (maxTicks timeout, unattributed throw, or crash)',
      });
    }
  }

  // A verdict for something never announced as loaded still counts — losing it would be worse than
  // the inconsistency it represents.
  for (const id of [...report.passed, ...failedById.keys()]) {
    if (report.loaded.includes(id)) { continue; }

    verdicts.push(
      failedById.has(id)
        ? { id, outcome: 'fail', error: failedById.get(id) }
        : { id, outcome: 'pass' },
    );
  }

  // Announced but never even loaded: the plot never got placed. Distinct from a failure because the
  // cause is structural (missing .mcstructure, tag mismatch), and the message should say so.
  const shortfall = (report.expected ?? 0) - verdicts.length;

  for (let i = 0; i < shortfall; i++) {
    verdicts.push({
      id: `<unidentified test ${i + 1} of ${shortfall}>`,
      outcome: 'absent',
      error: 'announced by the engine but never loaded (missing structure, or the plot could not be placed)',
    });
  }

  return verdicts;
}

export interface Summary {
  verdicts: Verdict[];
  passed: number;
  failed: number;
  absent: number;
  unobservable: number;
  total: number;
  expected: number | null;
  tag: string | null;
  experiments: string[];

  /**
   * Set when the transcript itself is untrustworthy — the engine announced nothing, or the tag
   * matched nothing. Distinct from test failures: this is exit code 2, not 1.
   */
  infraError: string | null;
}

export function summarise(report: Report): Summary {
  const verdicts = reconcile(report);
  const count = (o: Outcome): number => verdicts.filter(v => v.outcome === o).length;

  let infraError: string | null = null;

  if (report.noTestsForTag !== null) {
    infraError = `the engine found no tests for tag '${report.noTestsForTag}'`;
  } else if (report.expected === null && verdicts.length === 0) {
    infraError
      = 'the engine announced no test run at all — the pack may not have loaded, or these log lines have been renamed by a newer engine';
  }

  return {
    verdicts,
    passed: count('pass'),
    failed: count('fail'),
    absent: count('absent'),
    unobservable: count('unobservable'),
    total: verdicts.length,
    expected: report.expected,
    tag: report.tag,
    experiments: report.experiments,
    infraError,
  };
}
