import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_FILE } from '../bds/paths';
import { MANAGED_PROPERTIES } from './properties';

/** One `server.properties` key as the server ships it: its default and the comment that documents it. */
export interface PropertySpec {
  key: string;
  default?: string;
  description: string;
  allowed?: string;
}

/**
 * A `key=value` line. A commented-out key (`# key=value`) only counts when the value has no
 * whitespace; that separates it from prose such as `# force-gamemode=false (or ...)`.
 */
const KEY_LINE_RE = /^(?:([a-z][a-z0-9-]*)=(.*?)|#\s?([a-z][a-z0-9-]*)=(\S*))\s*$/;

function keyLine(line: string): [key: string, value: string] | undefined {
  const m = KEY_LINE_RE.exec(line);

  if (!m) { return undefined; }

  return m[1] !== undefined ? [m[1], m[2]] : [m[3], m[4]];
}

const ALLOWED_RE = /^allowed values:\s*(.*)$/i;
const DEFAULT_RE = /^default:\s*(.*)$/i;

/** Reads the keys, defaults and documentation out of a shipped `server.properties`. */
export function parseServerProperties(text: string): PropertySpec[] {
  const lines = text.split(/\r?\n/);
  const specs: PropertySpec[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const found = keyLine(lines[i]);

    if (!found || seen.has(found[0])) { continue; }

    const [key, value] = found;
    const description: string[] = [];
    let allowed: string | undefined;

    // The documentation is the comment block directly under the key, up to the next blank line.
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];

      if (line.trim() === '' || keyLine(line)) { break; }

      if (!line.startsWith('#')) { break; }

      const body = line.replace(/^#\s?/, '');
      const allowedMatch = ALLOWED_RE.exec(body);

      if (allowedMatch) {
        allowed = allowedMatch[1];

        // Multi-line allowed-value lists continue on indented comment lines.
        while (j + 1 < lines.length && /^#\s{2,}/.test(lines[j + 1])) {
          allowed += ` ${lines[++j].replace(/^#\s*/, '')}`;
        }

        continue;
      }

      if (DEFAULT_RE.test(body)) { continue; }

      description.push(body);
    }

    seen.add(key);
    specs.push({
      key,
      default: value === '' ? undefined : value,
      description: description.join('\n').trim(),
      allowed,
    });
  }

  return specs;
}

type JsonSchema = Record<string, unknown>;

function quotedValues(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"/g)].map(m => m[1]);
}

/**
 * Turns an "Allowed values" sentence into a schema. The wording is Mojang's and only loosely
 * regular, so anything unrecognised falls back to a permissive type.
 */
function schemaForAllowed(allowed: string | undefined, fallback: string | undefined): JsonSchema {
  const text = (allowed ?? '').trim();
  const lower = text.toLowerCase();

  if (/^"true" or "false"$/.test(lower) || /^true,\s*false$/.test(lower)) { return { type: 'boolean' }; }

  let range = /\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/.exec(text);

  if (!range) { range = /^(\d+)-(\d+)$/.exec(text); }

  if (range) {
    const [, lo, hi] = range;
    const isInt = !lo.includes('.') && !hi.includes('.') && !/value in the range/i.test(text);
    const number: JsonSchema = { type: isInt ? 'integer' : 'number', minimum: Number(lo), maximum: Number(hi) };
    const words = quotedValues(text);

    return words.length > 0 ? { oneOf: [{ enum: words }, number] } : number;
  }

  if (/integer/i.test(text)) {
    const schema: JsonSchema = { type: 'integer' };

    if (/non-negative|or 0/i.test(text)) { schema.minimum = 0; } else if (/positive/i.test(text)) {
      const floor = /equal to (\d+) or greater/i.exec(text);

      schema.minimum = floor ? Number(floor[1]) : 1;
    }

    return schema;
  }

  const words = quotedValues(text);

  if (words.length > 0 && /^("[^"]*"(,?\s*(or\s+)?))+$/.test(text)) { return { enum: words }; }

  if (/string|literal|ip/i.test(lower)) { return { type: 'string' }; }

  // No usable sentence: infer from the shipped default.
  if (fallback === 'true' || fallback === 'false') { return { type: 'boolean' }; }

  if (fallback !== undefined && /^-?\d+$/.test(fallback)) { return { type: 'integer' }; }

  if (fallback !== undefined && /^-?\d*\.\d+$/.test(fallback)) { return { type: 'number' }; }

  return { type: ['string', 'number', 'boolean'] };
}

function typedDefault(value: string | undefined, schema: JsonSchema): unknown {
  if (value === undefined) { return undefined; }

  const type = schema.type;

  if (type === 'boolean') { return value === 'true'; }

  if (type === 'integer' || type === 'number') {
    const n = Number(value);

    return Number.isFinite(n) ? n : value;
  }

  return value;
}

/** The JSON Schema for a `bds-runner.json`, with `properties` typed from the given server's keys. */
export function buildConfigSchema(specs: PropertySpec[], serverVersion: string): JsonSchema {
  const properties: Record<string, JsonSchema> = {};

  for (const spec of specs) {
    const schema = schemaForAllowed(spec.allowed, spec.default);
    const defaultValue = typedDefault(spec.default, schema);
    const entry: JsonSchema = { ...schema };

    if (spec.description) { entry.description = spec.description; }

    if (defaultValue !== undefined) { entry.default = defaultValue; }

    const managedBy = MANAGED_PROPERTIES.get(spec.key);

    if (managedBy) {
      entry.deprecated = true;
      entry.deprecationMessage = `Managed by bc-bds (${managedBy}). Setting it here is an error.`;
    }

    properties[spec.key] = entry;
  }

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: CONFIG_FILE,
    description: `bc-bds configuration. Server property keys are from Bedrock Dedicated Server ${serverVersion}.`,
    type: 'object',
    properties: {
      $schema: { type: 'string' },
      version: {
        type: 'string',
        description: 'An exact build such as 1.26.45.1, or "latest".',
        default: 'latest',
      },
      channel: {
        enum: ['stable', 'preview'],
        default: 'stable',
      },
      properties: {
        type: 'object',
        description: 'Overrides written into server.properties before every run.',
        properties,
        additionalProperties: { type: ['string', 'number', 'boolean'] },
      },
    },
    additionalProperties: false,
  };
}

/**
 * Writes the config schema for the server at `bdsDir` to `outFile`.
 *
 * Runs on every resolve, so the schema always describes the build the next run will use.
 */
export async function writeConfigSchema(bdsDir: string, serverVersion: string, outFile: string): Promise<void> {
  const shipped = await fs.readFile(path.join(bdsDir, 'server.properties'), 'utf8');
  const schema = buildConfigSchema(parseServerProperties(shipped), serverVersion);

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, `${JSON.stringify(schema, null, 2)}\n`);
}
