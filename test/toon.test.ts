import { describe, it, expect } from 'vitest';
import {
  extract,
  field,
  pluck,
  custom,
  joinArray,
  renderList,
  truncateForDisplay,
  type FieldDef,
} from '../src/toon.js';

describe('extract', () => {
  it('extracts a flat field', () => {
    expect(extract({ n: 7 }, [field('n')])).toEqual({ n: 7 });
  });

  it('plucks a nested value', () => {
    expect(extract({ team: { key: 'LIN' } }, [pluck('team', 'key')])).toEqual({
      team: 'LIN',
    });
  });

  it('runs a custom extractor', () => {
    const schema: FieldDef[] = [
      custom('state', (i) => i.state?.name?.toLowerCase() ?? ''),
    ];
    expect(extract({ state: { name: 'In Progress' } }, schema)).toEqual({
      state: 'in progress',
    });
  });

  it('joins array subkeys', () => {
    const schema = [joinArray('labels', 'name')];
    expect(
      extract({ labels: { nodes: [{ name: 'bug' }, { name: 'x' }] } }, schema),
    ).toEqual({ labels: 'bug,x' });
  });
});

describe('renderList', () => {
  it('renders a list with a label', () => {
    const out = renderList(
      'issues',
      [{ id: '1', title: 'Fix', state: { name: 'Open' } }],
      [field('id'), field('title')],
    );
    expect(out).toContain('issues[1]');
    expect(out).toContain('Fix');
  });
});

describe('truncateForDisplay', () => {
  it('returns text unchanged when under the limit', () => {
    const r = truncateForDisplay('short', 100);
    expect(r).toEqual({ preview: 'short', total: 5, truncated: false });
  });

  it('truncates with a size hint', () => {
    const long = 'x'.repeat(2000);
    const r = truncateForDisplay(long, 1000);
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(2000);
    expect(r.preview.length).toBe(1003); // 1000 + '...'
  });
});
