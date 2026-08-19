// Tests for `issues --search` — the first suite here to exercise the
// command/transport path against a stubbed global fetch (no network, ever).
// The pattern: vi.stubGlobal('fetch', ...) a fake GraphQL endpoint, then
// assert on the captured query document and variables.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { issuesCommand } from '../src/commands/issues.js';
import { fetchIssues } from '../src/linear.js';
import { AxiError } from '../src/errors.js';
import type { LinearIssue } from '../src/linear.js';

const FAKE_KEY = 'lin_api_fake';

interface CapturedRequest {
  url: string;
  body: { query: string; variables: Record<string, unknown> };
}

/** A minimal Linear issue node matching ISSUE_LIST_FIELDS. */
function issueNode(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'ir-1',
    identifier: 'LIN-1',
    title: 'Onboarding checklist',
    state: { name: 'Started', type: 'started' },
    priority: 2,
    assignee: { name: 'Ada' },
    team: { key: 'LIN' },
    updatedAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
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

describe('fetchIssues search dispatch', () => {
  it('uses the searchIssues query with term + first when search is set', async () => {
    const { requests } = stubLinearFetch(() => ({
      searchIssues: { nodes: [issueNode()] },
    }));

    const { issues } = await fetchIssues(
      FAKE_KEY,
      { search: 'onboarding' },
      25,
    );

    expect(issues).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.linear.app/graphql');
    expect(requests[0].body.query).toContain('searchIssues(');
    expect(requests[0].body.query).toContain('term: $term');
    expect(requests[0].body.query).toContain('first: $first');
    // No composed filter → no filter: argument at all.
    expect(requests[0].body.query).not.toContain('filter:');
    expect(requests[0].body.variables).toEqual({
      term: 'onboarding',
      first: 25,
    });
  });

  it('composes search with team + state + label into the IssueFilter', async () => {
    const { requests } = stubLinearFetch(() => ({
      searchIssues: { nodes: [] },
    }));

    await fetchIssues(
      FAKE_KEY,
      { search: 'x', team: 'lin', stateType: 'started', label: 'bug' },
      10,
    );

    const query = requests[0].body.query;
    expect(query).toContain('searchIssues(');
    expect(query).toContain(
      'filter: { team: { key: { eq: "LIN" } }, state: { type: { eq: "started" } }, labels: { name: { eq: "bug" } } }',
    );
    expect(requests[0].body.variables).toEqual({ term: 'x', first: 10 });
  });

  it('still uses the plain issues query (updatedAt order) without search', async () => {
    const { requests } = stubLinearFetch(() => ({
      issues: { nodes: [issueNode()] },
    }));

    await fetchIssues(FAKE_KEY, { team: 'LIN' }, 25);

    const query = requests[0].body.query;
    expect(query).toContain('issues(');
    expect(query).toContain('orderBy: updatedAt');
    expect(query).not.toContain('searchIssues');
    expect(requests[0].body.variables).toEqual({ first: 25 });
  });
});

describe('issues command --search', () => {
  it('is accepted by KNOWN_FLAGS and renders searchIssues results', async () => {
    const { requests } = stubLinearFetch(() => ({
      searchIssues: {
        nodes: [issueNode({ identifier: 'LIN-7', title: 'Fix onboarding' })],
      },
    }));

    const out = await issuesCommand(['--search', 'onboarding'], {
      apiKey: FAKE_KEY,
    });

    expect(requests[0].body.query).toContain('searchIssues(');
    expect(out).toContain('LIN-7');
    expect(out).toContain('Fix onboarding');
  });

  it('composes --search with --team and --state', async () => {
    const { requests } = stubLinearFetch(() => ({
      searchIssues: { nodes: [] },
    }));

    const out = await issuesCommand(
      ['--search', 'x', '--team', 'LIN', '--state', 'started'],
      { apiKey: FAKE_KEY },
    );

    const query = requests[0].body.query;
    expect(query).toContain('searchIssues(');
    expect(query).toContain('team: { key: { eq: "LIN" } }');
    expect(query).toContain('state: { type: { eq: "started" } }');
    expect(requests[0].body.variables).toEqual({ term: 'x', first: 25 });
    // Definitive empty state + search-specific hint.
    expect(out).toContain('issues: 0 found');
    expect(out).toContain('No matches for "x"');
  });

  it('resolves --assignee me (viewer round trip) then searches with the email filter', async () => {
    const { requests } = stubLinearFetch((req) => {
      if (req.body.query.includes('viewer')) {
        return {
          viewer: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
        };
      }
      return { searchIssues: { nodes: [] } };
    });

    await issuesCommand(['--search', 'onboarding', '--assignee', 'me'], {
      apiKey: FAKE_KEY,
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].body.query).toContain('viewer');
    const search = requests[1];
    expect(search.body.query).toContain('searchIssues(');
    expect(search.body.query).toContain(
      'assignee: { email: { eq: "ada@example.com" } }',
    );
    expect(search.body.variables).toEqual({ term: 'onboarding', first: 25 });
  });

  it('rejects --search with a missing or blank value instead of dropping it', async () => {
    stubLinearFetch(() => ({}));

    await expect(
      issuesCommand(['--search'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(AxiError);

    await expect(
      issuesCommand(['--search='], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/--search requires a value/);
  });

  it('still rejects unknown flags alongside --search', async () => {
    stubLinearFetch(() => ({}));

    await expect(
      issuesCommand(['--search', 'x', '--bogus'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/unknown flag --bogus/);
  });
});
