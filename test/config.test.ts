import { describe, it, expect } from 'vitest';
import { resolveGlobalFlags, parseIssueRef } from '../src/config.js';

describe('resolveGlobalFlags', () => {
  it('strips --key in space form and resolves the key', () => {
    const g = resolveGlobalFlags(
      ['issues', '--key', 'lin_api_x', '--team', 'LIN'],
      {},
    );
    expect(g.apiKey).toBe('lin_api_x');
    expect(g.args).toEqual(['issues', '--team', 'LIN']);
  });

  it('strips --key= in equals form', () => {
    const g = resolveGlobalFlags(['--key=lin_api_x', 'issues'], {});
    expect(g.apiKey).toBe('lin_api_x');
    expect(g.args).toEqual(['issues']);
  });

  it('prefers the flag over env and config', () => {
    const g = resolveGlobalFlags(
      ['--key', 'flag-key'],
      { LINEAR_API_KEY: 'env-key' },
    );
    expect(g.apiKey).toBe('flag-key');
  });

  it('falls back to LINEAR_API_KEY env', () => {
    const g = resolveGlobalFlags(['issues'], { LINEAR_API_KEY: 'env-key' });
    expect(g.apiKey).toBe('env-key');
    expect(g.args).toEqual(['issues']);
  });

  it('returns undefined apiKey when nothing is resolvable', () => {
    const g = resolveGlobalFlags(['issues'], {});
    expect(g.apiKey).toBeUndefined();
  });
});

describe('parseIssueRef', () => {
  it('parses a UUID', () => {
    const ref = parseIssueRef('11111111-2222-3333-4444-555555555555');
    expect(ref).toEqual({
      kind: 'uuid',
      id: '11111111-2222-3333-4444-555555555555',
    });
  });

  it('parses an identifier', () => {
    const ref = parseIssueRef('LIN-123');
    expect(ref).toEqual({ kind: 'identifier', team: 'LIN', number: 123 });
  });

  it('uppercases the team key', () => {
    expect(parseIssueRef('eng-9')).toEqual({
      kind: 'identifier',
      team: 'ENG',
      number: 9,
    });
  });

  it('rejects garbage', () => {
    expect(() => parseIssueRef('not-a-ref')).toThrow();
  });
});
