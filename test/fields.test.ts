import { describe, it, expect } from 'vitest';
import { parseFields } from '../src/fields.js';
import { field } from '../src/toon.js';
import { AxiError } from '../src/errors.js';

describe('parseFields', () => {
  const available = {
    url: { linearKey: 'url', def: field('url') },
    priority: { linearKey: 'priority', def: field('priority') },
  };

  it('returns empty when undefined', () => {
    expect(parseFields(undefined, available)).toEqual({
      extraDefs: [],
      extraLinearKeys: [],
    });
  });

  it('parses a known field', () => {
    const r = parseFields('url', available);
    expect(r.extraLinearKeys).toEqual(['url']);
    expect(r.extraDefs).toHaveLength(1);
  });

  it('parses multiple comma-separated fields', () => {
    const r = parseFields('url,priority', available);
    expect(r.extraLinearKeys.sort()).toEqual(['priority', 'url']);
  });

  it('throws on unknown fields', () => {
    expect(() => parseFields('bogus', available)).toThrow(AxiError);
  });
});
