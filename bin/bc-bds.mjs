#!/usr/bin/env node
/** The package ships TypeScript sources; the CLI loads them through jiti. */
import { createJiti } from 'jiti';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);

await jiti.import(path.join(here, '..', 'src', 'cli.ts'));
