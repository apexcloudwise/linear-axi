import { describe, it, expect } from 'vitest';
import { formatCountLine } from '../src/format.js';

describe('formatCountLine', () => {
  it('simple count', () => {
    expect(formatCountLine({ count: 3 })).toBe('count: 3');
  });

  it('count of total', () => {
    expect(formatCountLine({ count: 3, totalCount: 847 })).toBe(
      'count: 3 of 847 total',
    );
  });

  it('truncated by limit', () => {
    expect(formatCountLine({ count: 25, limit: 25 })).toBe(
      'count: 25 (showing first 25)',
    );
  });

  it('zero is a simple count', () => {
    expect(formatCountLine({ count: 0 })).toBe('count: 0');
  });
});
