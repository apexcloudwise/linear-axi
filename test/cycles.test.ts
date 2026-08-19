// Tests for the `cycles` command and `issues --cycle` filter (#21), following
// the network-free GraphQL stub pattern from projects.test.ts: stub global
// fetch, then assert on the captured query document, variables, and rendered
// TOON output.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cyclesCommand, CYCLES_HELP } from '../src/commands/cycles.js';
import { issuesCommand, ISSUES_HELP } from '../src/commands/issues.js';
import { fetchCycles } from '../src/linear.js';
import { AxiError } from '../src/errors.js';
import type { LinearCycle, LinearIssue } from '../src/linear.js';

const FAKE_KEY = 'lin_api_fake';

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO timestamp n days from now (negative = past) — keeps status derivation stable forever. */
function daysFromNow(n: number): string {
  return new Date(Date.now() + n * DAY_MS).toISOString();
}

/** A minimal Linear cycle node matching CYCLE_LIST_FIELDS (+ team via the root connection). */
function cycleNode(overrides: Partial<LinearCycle> = {}): LinearCycle {
  return {
    id: 'cy-1',
    number: 42,
    startsAt: daysFromNow(-10),
    endsAt: daysFromNow(4),
    progress: 0.25,
    team: { key: 'LIN' },
    ...overrides,
  };
}

/** A minimal Linear issue node matching ISSUE_LIST_FIELDS. */
function issueNode(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'ir-1',
    identifier: 'LIN-1',
    title: 'Ship the thing',
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

interface CapturedRequest {
  url: string;
  body: { query: string; variables: Record<string, unknown> };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cycles command', () => {
  it('queries the root cycles connection recent-first and renders number, team, status, range, and progress', async () => {
    const start = daysFromNow(-10);
    const end = daysFromNow(4);
    const { requests } = stubLinearFetch(() => ({
      cycles: {
        nodes: [cycleNode({ startsAt: start, endsAt: end })],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }));

    const out = await cyclesCommand([], { apiKey: FAKE_KEY });

    const query = requests[0].body.query;
    expect(requests[0].url).toBe('https://api.linear.app/graphql');
    expect(query).toContain('query Cycles(');
    expect(query).toContain(
      'cycles(first: $first, after: $after, orderBy: updatedAt)',
    );
    expect(query).toContain('number');
    expect(query).toContain('startsAt');
    expect(query).toContain('endsAt');
    expect(query).toContain('progress');
    expect(query).toContain('team { key }'); // mixed-team rows are attributed
    expect(requests[0].body.variables).toEqual({ first: 10 });
    expect(out).toContain('42'); // cycle number
    expect(out).toContain('LIN'); // team attribution
    expect(out).toContain('active'); // now is between start and end
    expect(out).toContain(`${start.slice(0, 10)}..${end.slice(0, 10)}`);
    expect(out).toContain('25'); // progress 0.25 rendered as integer percent
    expect(out).toContain('count: 1');
  });

  it('resolves --team and queries the team { cycles } connection without the team column', async () => {
    const { requests } = stubLinearFetch((req) => {
      if (req.body.query.includes('TeamByKey')) {
        return { teams: { nodes: [{ id: 'team-1', key: 'LIN' }] } };
      }
      return {
        team: {
          cycles: {
            nodes: [cycleNode()],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    });

    const out = await cyclesCommand(['--team', 'LIN'], { apiKey: FAKE_KEY });

    expect(requests[0].body.query).toContain(
      'teams(filter: { key: { eq: $key } })',
    );
    expect(requests[0].body.variables).toEqual({ key: 'LIN' });

    const query = requests[1].body.query;
    expect(query).toContain('query TeamCycles(');
    expect(query).toContain('team(id: $id)');
    expect(query).toContain(
      'cycles(first: $first, after: $after, orderBy: updatedAt)',
    );
    // Per-team rows don't re-select team { key } — the team is already known.
    expect(query).not.toContain('team { key }');
    expect(requests[1].body.variables).toEqual({ id: 'team-1', first: 10 });
    expect(out).toContain('42');
    expect(out).toContain('active');
    expect(out).toContain('count: 1');
  });

  it('rejects an unknown --team key loudly', async () => {
    stubLinearFetch(() => ({ teams: { nodes: [] } }));

    await expect(
      cyclesCommand(['--team', 'NOPE'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/Team "NOPE" not found/);
  });

  it('derives past and upcoming statuses from the date range', async () => {
    const past = cycleNode({
      id: 'cy-p',
      number: 40,
      startsAt: daysFromNow(-20),
      endsAt: daysFromNow(-10),
    });
    const upcoming = cycleNode({
      id: 'cy-u',
      number: 43,
      startsAt: daysFromNow(2),
      endsAt: daysFromNow(12),
    });
    const active = cycleNode({ id: 'cy-a', number: 42 });
    stubLinearFetch(() => ({ cycles: { nodes: [past, upcoming, active] } }));

    const out = await cyclesCommand([], { apiKey: FAKE_KEY });

    expect(out).toContain('past');
    expect(out).toContain('upcoming');
    expect(out).toContain('active');
  });

  it('renders a definitive empty state when the workspace has no cycles', async () => {
    stubLinearFetch(() => ({
      cycles: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    }));

    const out = await cyclesCommand([], { apiKey: FAKE_KEY });

    expect(out).toContain('cycles: 0 found');
    expect(out).toContain('No cycles in this workspace yet');
  });

  it('hints at issues --cycle when cycles are listed', async () => {
    stubLinearFetch(() => ({
      cycles: {
        nodes: [cycleNode()],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }));

    const out = await cyclesCommand([], { apiKey: FAKE_KEY });

    expect(out).toContain('issues --cycle current --team LIN');
  });

  it('rejects unknown flags loudly (only --team is valid)', async () => {
    stubLinearFetch(() => ({}));

    await expect(
      cyclesCommand(['--limit', '5'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/unknown flag --limit/);
  });

  it('rejects a missing or blank --team value instead of listing all teams', async () => {
    stubLinearFetch(() => ({}));

    await expect(
      cyclesCommand(['--team'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/--team requires a value/);
    await expect(
      cyclesCommand(['--team='], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/--team requires a value/);
  });

  it('auto-paginates in 50-size batches until the limit is satisfied', async () => {
    const many = (start: number, count: number): LinearCycle[] =>
      Array.from({ length: count }, (_, i) =>
        cycleNode({ id: `cy-${start + i}`, number: start + i }),
      );

    const { requests } = stubLinearFetch((req) => {
      const after = req.body.variables['after'];
      if (after === undefined)
        return {
          cycles: {
            nodes: many(1, 50),
            pageInfo: { hasNextPage: true, endCursor: 'c1' },
          },
        };
      if (after === 'c1')
        return {
          cycles: {
            nodes: many(51, 50),
            pageInfo: { hasNextPage: true, endCursor: 'c2' },
          },
        };
      if (after === 'c2')
        return {
          cycles: {
            nodes: many(101, 20),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      return {
        cycles: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    });

    const { cycles, hasMore } = await fetchCycles(FAKE_KEY, undefined, 120);

    expect(requests).toHaveLength(3);
    expect(requests[0].body.variables).toEqual({ first: 50 });
    expect(requests[1].body.variables).toEqual({ first: 50, after: 'c1' });
    expect(requests[2].body.variables).toEqual({ first: 20, after: 'c2' });
    expect(cycles).toHaveLength(120);
    expect(cycles[0]!.number).toBe(1);
    expect(cycles[119]!.number).toBe(120);
    expect(hasMore).toBe(false);
  });

  it('documents columns and the --team flag in --help', () => {
    expect(CYCLES_HELP).toContain('--team <KEY>');
    expect(CYCLES_HELP).toContain('past, active, or upcoming');
    expect(CYCLES_HELP).toContain('percent complete, 0-100');
    expect(CYCLES_HELP).toContain('issues --cycle current --team LIN');
  });
});

describe('issues --cycle filter', () => {
  it('composes --cycle current with --team into the IssueFilter', async () => {
    const { requests } = stubLinearFetch(() => ({
      issues: { nodes: [issueNode()] },
    }));

    const out = await issuesCommand(['--cycle', 'current', '--team', 'LIN'], {
      apiKey: FAKE_KEY,
    });

    const query = requests[0].body.query;
    expect(query).toContain('issues(');
    expect(query).toContain('cycle: { isActive: { eq: true } }');
    expect(query).toContain('team: { key: { eq: "LIN" } }');
    expect(out).toContain('LIN-1');
  });

  it('applies --cycle current without --team across every active cycle', async () => {
    const { requests } = stubLinearFetch(() => ({
      issues: { nodes: [issueNode()] },
    }));

    await issuesCommand(['--cycle', 'current'], { apiKey: FAKE_KEY });

    const query = requests[0].body.query;
    expect(query).toContain('cycle: { isActive: { eq: true } }');
    expect(query).not.toContain('team: {');
  });

  it('filters a numeric --cycle to that team cycle number', async () => {
    const { requests } = stubLinearFetch(() => ({
      issues: { nodes: [issueNode()] },
    }));

    await issuesCommand(['--cycle', '42', '--team', 'LIN'], {
      apiKey: FAKE_KEY,
    });

    const query = requests[0].body.query;
    expect(query).toContain('cycle: { number: { eq: 42 } }');
    expect(query).toContain('team: { key: { eq: "LIN" } }');
  });

  it('rejects a numeric --cycle without --team loudly', async () => {
    stubLinearFetch(() => ({}));

    await expect(
      issuesCommand(['--cycle', '42'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(AxiError);
    await expect(
      issuesCommand(['--cycle', '7'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/requires --team/);
  });

  it('rejects values that are neither "current" nor a positive number', async () => {
    stubLinearFetch(() => ({}));

    await expect(
      issuesCommand(['--cycle', 'next'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/Invalid --cycle: next/);
    await expect(
      issuesCommand(['--cycle', '0'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/Invalid --cycle: 0/);
    await expect(
      issuesCommand(['--cycle', '-3'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/Invalid --cycle: -3/);
  });

  it('rejects a missing or blank --cycle value instead of dropping it', async () => {
    stubLinearFetch(() => ({}));

    await expect(
      issuesCommand(['--cycle'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/--cycle requires a value/);
    await expect(
      issuesCommand(['--cycle='], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/--cycle requires a value/);
  });

  it('composes --cycle with --search in the searchIssues query', async () => {
    const { requests } = stubLinearFetch(() => ({
      searchIssues: { nodes: [] },
    }));

    const out = await issuesCommand(
      ['--search', 'crash', '--cycle', 'current', '--team', 'LIN'],
      { apiKey: FAKE_KEY },
    );

    const query = requests[0].body.query;
    expect(query).toContain('searchIssues(');
    expect(query).toContain('cycle: { isActive: { eq: true } }');
    expect(query).toContain('team: { key: { eq: "LIN" } }');
    expect(requests[0].body.variables).toEqual({ term: 'crash', first: 25 });
    expect(out).toContain('issues: 0 found');
  });

  it('hints at cycles when a cycle filter matches nothing', async () => {
    stubLinearFetch(() => ({ issues: { nodes: [] } }));

    const out = await issuesCommand(['--cycle', '42', '--team', 'LIN'], {
      apiKey: FAKE_KEY,
    });

    expect(out).toContain('No issues in cycle 42');
    expect(out).toContain('`linear-axi cycles --team LIN`');

    stubLinearFetch(() => ({ issues: { nodes: [] } }));

    const out2 = await issuesCommand(['--cycle', 'current'], {
      apiKey: FAKE_KEY,
    });

    expect(out2).toContain('No issues in an active cycle');
  });

  it('documents --cycle in --help', () => {
    expect(ISSUES_HELP).toContain('--cycle <current|number>');
    expect(ISSUES_HELP).toContain('requires --team');
    expect(ISSUES_HELP).toContain('linear-axi cycles');
  });
});
