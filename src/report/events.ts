import { parseReport } from './parse';

export interface TestEvent { type: 'test.started' | 'test.passed' | 'test.failed'; id: string; error?: string }

/** IDE events use the same native verdict parser as terminal runs. */
export function testEvents(line: string): TestEvent[] {
  const report = parseReport(line);

  return [
    ...report.loaded.map(id => ({ type: 'test.started' as const, id })),
    ...report.passed.map(id => ({ type: 'test.passed' as const, id })),
    ...report.failed.map(value => ({ type: 'test.failed' as const, ...value })),
  ];
}
