import { describe, it, expect } from 'vitest';
import {
  takeFlag,
  takeAllFlags,
  takeBoolFlag,
  getFlag,
  getPositional,
  assertKnownFlags,
} from '../src/args.js';
import { AxiError } from '../src/errors.js';

describe('args helpers', () => {
  it('takeFlag removes space and equals forms', () => {
    const a = ['--team', 'LIN', 'extra'];
    expect(takeFlag(a, '--team')).toBe('LIN');
    expect(a).toEqual(['extra']);

    const b = ['--team=ENG'];
    expect(takeFlag(b, '--team')).toBe('ENG');
    expect(b).toEqual([]);
  });

  it('takeAllFlags collects repeatable values and removes them', () => {
    const a = ['--label', 'bug', '--label', 'chore', 'x'];
    expect(takeAllFlags(a, '--label')).toEqual(['bug', 'chore']);
    expect(a).toEqual(['x']);
  });

  it('takeBoolFlag removes a boolean flag', () => {
    const a = ['--full', 'LIN-1'];
    expect(takeBoolFlag(a, '--full')).toBe(true);
    expect(a).toEqual(['LIN-1']);
  });

  it('getFlag reads without modifying', () => {
    const a = ['--team', 'LIN'];
    expect(getFlag(a, '--team')).toBe('LIN');
    expect(a).toEqual(['--team', 'LIN']);
  });

  it('getPositional returns the first non-flag', () => {
    expect(getPositional(['--team', 'LIN', 'LIN-1'])).toBe('LIN');
    expect(getPositional(['--full', 'LIN-1'])).toBe('LIN-1');
  });

  it('assertKnownFlags passes for known flags', () => {
    expect(() => assertKnownFlags(['--team', 'LIN'], ['--team'])).not.toThrow();
    expect(() =>
      assertKnownFlags(['--team=LIN'], ['--team']),
    ).not.toThrow();
  });

  it('assertKnownFlags throws on unknown flags', () => {
    expect(() => assertKnownFlags(['--bogus'], ['--team'])).toThrow(AxiError);
  });
});
