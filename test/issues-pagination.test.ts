// Tests for multi-label filtering and auto-pagination of `issues` (#18),
// extending the network-free GraphQL stub pattern from issues-search.test.ts:
// stub global fetch, then assert on the captured query document, variables,
// and how many requests the pagination loop issued.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { issuesCommand, ISSUES_HELP } from '../src/commands/issues.js';
import { fetchIssues } from '../src/linear.js';
import { AxiError } from '../src/errors.js';
import type { LinearIssue } from '../src/linear.js';

const FAKE_KEY = 'lin_api_fake';

interface CapturedRequest {
  url: string;
  body: { query: string; variables: Record<string, unknown> };
}

/** A minimal Linear issue node matching ISSUE_LIST_FIELDS. */
function issueNode(n: number): LinearIssue {
  return {
    id: `ir-${n}`,
    identifier: `LIN-${n}`,
    title: `Issue ${n}`,
    state: { name: 'Started', type: 'started' },
    priority: 2,
    assignee: { name: 'Ada' },
    team: { key: 'LIN' },
    updatedAt: '2026-08-19T00:00:00.000Z',
  };
}

/** `count` issue nodes numbered from `start` (inclusive). */
function nodes(start: number, count: number): LinearIssue[] {
  return Array.from({ length: count }, (_, i) => issueNode(start + i));
}

/** A Linear connection page: nodes plus the pageInfo the pager follows. */
function page(nodes: LinearIssue[], hasNextPage: boolean, endCursor?: string) {
  return {
    nodes,
    pageInfo: { hasNextPage, endCursor: endCursor ?? null },
  };
}

function graphqlOk(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data }) } as Response;
}

/**
 * Stub global fetch as a Linear GraphQL endpoint. Returns the captured
 * requests so tests can assert on the query/variables that were sent.
 */
function stubLinearFetch(respond: (body: CapturedRequest) => unknown): {
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest['body'];
    const captured: CapturedRequest = { url: String(url), body };
    requests.push(captured);
    return graphqlOk(respond(captured));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('multi-label filter', () => {
  it('sends every repeated --label as an "any of" in-comparator', async () => {
    const { requests } = stubLinearFetch(() => ({
      issues: page(nodes(1, 2), false),
    }));

    const out = await issuesCommand(
      ['--label', 'bug', '--label', 'regression'],
      { apiKey: FAKE_KEY },
    );

    expect(requests[0].body.query).toContain(
      'labels: { some: { name: { in: ["bug","regression"] } } }',
    );
    expect(out).toContain('LIN-1');
  });

  it('uses the same shape for a single label', async () => {
    const { requests } = stubLinearFetch(() => ({
      issues: page([], false),
    }));

    await fetchIssues(FAKE_KEY, { labels: ['bug'] }, 25);

    expect(requests[0].body.query).toContain(
      'labels: { some: { name: { in: ["bug"] } } }',
    );
  });

  it('composes multiple labels with --search in the searchIssues query', async () => {
    const { requests } = stubLinearFetch(() => ({
      searchIssues: page([], false),
    }));

    await issuesCommand(['--search', 'crash', '--label', 'a', '--label', 'b'], {
      apiKey: FAKE_KEY,
    });

    const query = requests[0].body.query;
    expect(query).toContain('searchIssues(');
    expect(query).toContain('labels: { some: { name: { in: ["a","b"] } } }');
    expect(requests[0].body.variables).toEqual({ term: 'crash', first: 25 });
  });

  it('no longer claims only the first label was applied', async () => {
    stubLinearFetch(() => ({ issues: page(nodes(1, 1), false) }));

    const out = await issuesCommand(
      ['--label', 'bug', '--label', 'regression'],
      { apiKey: FAKE_KEY },
    );

    expect(out).not.toContain('Only the first label');
    expect(out).not.toContain('post-v1');
  });

  it('hints the any-of semantics when repeated labels match nothing', async () => {
    stubLinearFetch(() => ({ issues: page([], false) }));

    const out = await issuesCommand(
      ['--label', 'bug', '--label', 'regression'],
      { apiKey: FAKE_KEY },
    );

    expect(out).toContain('No issues carry any of: bug, regression');
  });

  it('documents any-of semantics and the 500 cap in --help', () => {
    expect(ISSUES_HELP).toContain('repeat to match ANY of the given labels');
    expect(ISSUES_HELP).toContain('max 500');
    expect(ISSUES_HELP).not.toContain('capped at 50');
  });
});

describe('auto-pagination', () => {
  it('follows cursors in 50-size batches until --limit is satisfied', async () => {
    const { requests } = stubLinearFetch((req) => {
      const after = req.body.variables['after'];
      if (after === undefined)
        return { issues: page(nodes(1, 50), true, 'c1') };
      if (after === 'c1') return { issues: page(nodes(51, 50), true, 'c2') };
      return { issues: page(nodes(101, 20), true, 'c3') };
    });

    const { issues, hasMore } = await fetchIssues(FAKE_KEY, {}, 120);

    expect(requests).toHaveLength(3);
    expect(requests[0].body.query).toContain(
      'pageInfo { hasNextPage endCursor }',
    );
    expect(requests[0].body.variables).toEqual({ first: 50 });
    expect(requests[1].body.variables).toEqual({ first: 50, after: 'c1' });
    // Only the remaining slots are requested on the last page.
    expect(requests[2].body.variables).toEqual({ first: 20, after: 'c2' });
    expect(issues).toHaveLength(120);
    expect(issues[0]!.identifier).toBe('LIN-1');
    expect(issues[119]!.identifier).toBe('LIN-120');
    expect(hasMore).toBe(true);
  });

  it('stops when the server exhausts results before --limit', async () => {
    const { requests } = stubLinearFetch((req) => {
      const after = req.body.variables['after'];
      if (after === undefined)
        return { issues: page(nodes(1, 50), true, 'c1') };
      return { issues: page(nodes(51, 25), false) };
    });

    const out = await issuesCommand(['--limit', '200'], { apiKey: FAKE_KEY });

    expect(requests).toHaveLength(2);
    expect(requests[1].body.variables).toEqual({ first: 50, after: 'c1' });
    expect(out).toContain('LIN-75');
    expect(out).not.toContain('LIN-76');
    // hasMore came back false → no truncation hint on a count below the limit.
    expect(out).toContain('count: 75');
    expect(out).not.toContain('showing first');
  });

  it('--limit 25 fetches a single page of 25 and stops when satisfied', async () => {
    const { requests } = stubLinearFetch(() => ({
      issues: page(nodes(1, 25), true, 'c1'),
    }));

    const out = await issuesCommand(['--limit', '25'], { apiKey: FAKE_KEY });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.variables).toEqual({ first: 25 });
    expect(out).toContain('count: 25 (showing first 25)');
  });

  it('keeps paging when a page comes back short but hasNextPage is true', async () => {
    const { requests } = stubLinearFetch((req) => {
      const after = req.body.variables['after'];
      if (after === undefined)
        return { issues: page(nodes(1, 10), true, 'c1') };
      return { issues: page(nodes(11, 15), false) };
    });

    const out = await issuesCommand(['--limit', '25'], { apiKey: FAKE_KEY });

    expect(requests).toHaveLength(2);
    expect(requests[1].body.variables).toEqual({ first: 15, after: 'c1' });
    expect(out).toContain('LIN-25');
    // The server said it was done on page 2 → plain count, no hint.
    expect(out).toContain('count: 25');
    expect(out).not.toContain('showing first');
  });
});

describe('--limit cap', () => {
  it('accepts --limit 500', async () => {
    const { requests } = stubLinearFetch(() => ({
      issues: page(nodes(1, 1), false),
    }));

    const out = await issuesCommand(['--limit', '500'], { apiKey: FAKE_KEY });

    expect(requests[0].body.variables).toEqual({ first: 50 });
    expect(out).toContain('count: 1');
  });

  it('rejects --limit 501 loudly instead of clamping to 500', async () => {
    stubLinearFetch(() => ({}));

    const rejected = issuesCommand(['--limit', '501'], {
      apiKey: FAKE_KEY,
    });
    await expect(rejected).rejects.toBeInstanceOf(AxiError);
    await expect(rejected).rejects.toThrow(/max 500/);
  });
});
