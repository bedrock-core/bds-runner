export interface TestSelection { tag?: string; test?: string; tests?: readonly string[]; all?: boolean }

/** Select native tests without passing arbitrary console syntax. */
export function testSelection(options: TestSelection): { label: string; command: string } {
  const count = Number(options.tag !== undefined) + Number(options.test !== undefined) + Number(options.tests !== undefined) + Number(options.all === true);

  if (count !== 1) { throw new Error('Choose exactly one GameTest selector: tag, test, tests or all.'); }

  const identifiers = options.tests ?? (options.test !== undefined ? [options.test] : options.tag !== undefined ? [options.tag] : []);

  if (options.tests && (options.tests.length === 0 || new Set(options.tests).size !== options.tests.length)) { throw new Error('Selected GameTests must be a nonempty list of unique identifiers.'); }

  const value = options.test ?? options.tag;

  if (identifiers.some(id => !/^[A-Za-z0-9_.:-]+$/.test(id))) { throw new Error('GameTest identifiers cannot contain whitespace or console syntax.'); }

  return { label: options.tests ? `selected-${options.tests.length}` : value ?? 'all', command: options.test !== undefined ? `gametest run ${options.test}` : options.tests ? `gametest run ${options.tests[0]}` : options.all ? 'gametest runset' : `gametest runset ${options.tag}` };
}
