import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANAGED_PROPERTIES, renderServerProperties } from '../properties';
import { buildConfigSchema, parseServerProperties } from '../schema';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The `server.properties` exactly as BDS 1.26.43.1 ships it. */
const SHIPPED = readFileSync(path.join(here, 'fixtures', 'server.properties-1.26.43.1'), 'utf8');

type Schema = Record<string, unknown>;

function propertySchemas(): Record<string, Schema> {
  const schema = buildConfigSchema(parseServerProperties(SHIPPED), '1.26.43.1');
  const top = schema.properties as Record<string, Schema>;

  return (top.properties).properties as Record<string, Schema>;
}

describe('server:schema parse', () => {
  it('finds every documented key, including commented-out ones', () => {
    const keys = parseServerProperties(SHIPPED).map(s => s.key);

    expect(keys).toContain('server-name');
    expect(keys).toContain('server-ip');
    expect(keys).toContain('script-watchdog-hang-threshold');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('does not mistake explanatory prose for a key', () => {
    // `# force-gamemode=false (or force-gamemode is not defined ...` is a sentence, not a key line.
    const specs = parseServerProperties(SHIPPED).filter(s => s.key === 'force-gamemode');

    expect(specs).toHaveLength(1);
    expect(specs[0].default).toBe('false');
  });

  it('keeps the default and the documentation, without the allowed-values line', () => {
    const spec = parseServerProperties(SHIPPED).find(s => s.key === 'difficulty');

    expect(spec?.default).toBe('easy');
    expect(spec?.description).toBe('Sets the difficulty of the world.');
    expect(spec?.allowed).toBe('"peaceful", "easy", "normal", or "hard"');
  });
});

describe('server:schema build', () => {
  it('types booleans, enums, bounded integers and strings from the allowed-values wording', () => {
    const props = propertySchemas();

    expect(props['allow-cheats']).toMatchObject({ type: 'boolean', default: false });
    expect(props['difficulty']).toMatchObject({ enum: ['peaceful', 'easy', 'normal', 'hard'], default: 'easy' });
    expect(props['server-port']).toMatchObject({ type: 'integer', minimum: 1, maximum: 65535, default: 19132 });
    expect(props['max-players']).toMatchObject({ type: 'integer', minimum: 1, default: 10 });
    expect(props['server-name']).toMatchObject({ type: 'string', default: 'Dedicated Server' });
  });

  it('handles the mixed "Disabled or a number" wording', () => {
    const props = propertySchemas();

    expect(props['server-build-radius-ratio']).toMatchObject({
      oneOf: [{ enum: ['Disabled'] }, { type: 'number', minimum: 0, maximum: 1 }],
    });
  });

  it('marks the keys the runner owns', () => {
    const props = propertySchemas();

    for (const key of MANAGED_PROPERTIES.keys()) {
      expect(props[key]).toMatchObject({ deprecated: true });
    }
  });

  it('rejects unknown top-level keys and allows any server property', () => {
    const schema = buildConfigSchema(parseServerProperties(SHIPPED), '1.26.43.1');

    expect(schema.additionalProperties).toBe(false);
    expect((schema.properties as Record<string, Schema>).properties.additionalProperties).toEqual({
      type: ['string', 'number', 'boolean'],
    });
  });
});

describe('server:properties overrides', () => {
  const base = { levelName: 'w', port: 19140, portV6: 19141, watchdogHangMs: 60_000, lanVisible: false };

  it('lets the config override a default and add a key', () => {
    const text = renderServerProperties({ ...base, overrides: { 'view-distance': 12, 'level-seed': 'abc' } });

    expect(text).toContain('view-distance=12');
    expect(text).toContain('level-seed=abc');
  });

  it('refuses keys the runner owns, naming what controls them', () => {
    expect(() => renderServerProperties({ ...base, overrides: { 'server-port': 1 } })).toThrow(/--port/);
    expect(() => renderServerProperties({ ...base, overrides: { 'level-name': 'x' } })).toThrow(/managed by/);
  });

  it('keeps LAN visibility on for keep-alive even if the config turns it off', () => {
    const text = renderServerProperties({ ...base, lanVisible: true, overrides: { 'enable-lan-visibility': false } });

    expect(text).toContain('enable-lan-visibility=true');
  });
});
