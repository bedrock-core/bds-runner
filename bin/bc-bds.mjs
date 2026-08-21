#!/usr/bin/env node
/**
 * Thin launcher: the package ships TypeScript sources with no build step, matching the rest of the
 * monorepo, so the CLI is loaded through jiti rather than compiled ahead of time.
 */
import { createJiti } from 'jiti';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);

await jiti.import(path.join(here, '..', 'src', 'cli.ts'));
