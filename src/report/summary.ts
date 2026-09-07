import type { Summary, Verdict } from './parse';

const ANSI = {
  reset: '[0m',
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  bold: '[1m',
};

/** Colour is noise in a CI log that does not render it, so only use it on a real terminal. */
function paint(text: string, colour: keyof typeof ANSI): string {
  return process.stdout.isTTY ? `${ANSI[colour]}${text}${ANSI.reset}` : text;
}

function icon(verdict: Verdict): string {
  switch (verdict.outcome) {
    case 'pass': return paint('✓', 'green');
    case 'fail': return paint('✗', 'red');
    default: return paint('?', 'yellow');
  }
}

export interface FormatOptions {
  summary: Summary;
  durationMs: number;
  bdsVersion: string;

  /** Server output, so a failure can be shown with the lines around it. */
  transcript?: string;

  /** Ids expected to fail. Reported as `known` rather than as regressions. */
  knownFailures?: string[];
}

/** Shows the console lines around a failing test; the pack's own logging usually says what led to it. */
function contextFor(transcript: string, id: string, radius = 6): string[] {
  const lines = transcript.split(/\r?\n/);
  const at = lines.findIndex(line => line.includes(id) && /onTestFailed/.test(line));

  if (at < 0) { return []; }

  return lines
    .slice(Math.max(0, at - radius), at + 2)
    .filter(line => line.trim() !== '');
}

export function formatSummary(options: FormatOptions): string {
  const { summary, durationMs, bdsVersion, transcript = '', knownFailures = [] } = options;
  const out: string[] = [];
  const seconds = (durationMs / 1000).toFixed(1);

  const failures = summary.verdicts.filter(v => v.outcome === 'fail' || v.outcome === 'absent');
  const regressions = failures.filter(v => !knownFailures.includes(v.id));

  for (const verdict of failures) {
    const known = knownFailures.includes(verdict.id) ? paint(' (known)', 'dim') : '';

    out.push(`  ${icon(verdict)} ${verdict.id}${known}`);

    if (verdict.error) { out.push(`      ${paint(verdict.error, 'dim')}`); }

    for (const line of contextFor(transcript, verdict.id)) {
      out.push(`      ${paint(line, 'dim')}`);
    }

    out.push('');
  }

  const parts = [
    paint(`${summary.passed} passed`, summary.passed > 0 ? 'green' : 'dim'),
    `${summary.failed} failed`,
  ];

  if (summary.absent > 0) { parts.push(`${summary.absent} absent`); }

  if (summary.unobservable > 0) { parts.push(`${summary.unobservable} unobservable`); }

  const headline = regressions.length === 0
    ? paint('✓', 'green')
    : paint('✗', 'red');

  out.push(
    `${headline} ${paint(parts.join(', '), 'bold')}`
    + paint(`   (${summary.tag ?? 'no tag'}, BDS ${bdsVersion}, ${seconds}s)`, 'dim'),
  );

  if (knownFailures.length > 0 && failures.length > 0) {
    const knownHit = failures.filter(v => knownFailures.includes(v.id)).length;

    out.push(paint(`  ${knownHit} of ${failures.length} failure(s) are known and expected`, 'dim'));
  }

  if (summary.infraError) {
    out.push('');
    out.push(paint(`  infrastructure: ${summary.infraError}`, 'red'));
  }

  return out.join('\n');
}
