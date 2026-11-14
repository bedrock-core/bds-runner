import { parseReport, summarise, type Summary } from './parse';

/** Aggregate separate native invocations without losing earlier verdicts at the next run anchor. */
export function summariseSelection(transcript: string, fragments: readonly string[], requested: readonly string[]): Summary {
  const full = parseReport(transcript), parts = fragments.map(parseReport);
  const summary = summarise({ ...full, tag: null, expected: parts.every(part => part.expected !== null) ? parts.reduce((sum, part) => sum + (part.expected ?? 0), 0) : null,
    batches: parts.flatMap(part => part.batches), loaded: [...new Set(parts.flatMap(part => part.loaded))],
    passed: [...new Set(parts.flatMap(part => part.passed))], failed: parts.flatMap(part => part.failed), noTestsForTag: parts.find(part => part.noTestsForTag !== null)?.noTestsForTag ?? null });
  const observed = new Set(summary.verdicts.map(verdict => verdict.id.toLowerCase()));

  for (const id of requested) {
    if (!observed.has(id.toLowerCase())) {
      summary.verdicts.push({ id, outcome: 'absent', error: 'The requested GameTest produced no native verdict.' });
      summary.absent++; summary.total++;
      summary.infraError ||= 'One or more requested GameTests produced no native verdict.';
    }
  }

  return summary;
}
