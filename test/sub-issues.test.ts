// Tests for sub-issue support (#26): `issue create --parent <ref>` and the
// children block in `issue view --full`. Follows the network-free GraphQL
// stub pattern from project-cycle-assignment.test.ts: stub global fetch, then
// assert on the captured query documents, mutation variables, and rendered
// TOON output.
//
// Flow order under test:
// - create --parent: resolve the parent ref (query Issue, identifier or UUID)
//   BEFORE the mutation, then createIssue resolves the team (query TeamByKey)
//   and mutates with parentId.
// - view --full: the detail document gains the children connection and the
//   output gains a sub-issues block; without --full neither appears.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { issueCommand, ISSUE_HELP } from '../src/commands/issue.js';
import type { LinearIssue } from '../src/linear.js';

const FAKE_KEY = 'lin_api_fake';
const PARENT_UUID = '9b41d3e2-1111-4222-8333-444455556666';

interface CapturedRequest {
  url: string;
  body: { query: string; variables: Record<string, unknown> };
}

interface StubOptions {
  /** The issue served for `query Issue(` (default: LIN-42 with 2 children). */
  issue?: LinearIssue | null;
}

/**
 * A parent issue node as returned by ISSUE_DETAIL_FIELDS plus (when the
 * document asks for it) ISSUE_CHILDREN_FIELDS — the same fixture serves the
 * --parent resolution round trip and the viewed parent.
 */
function parentNode(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'ir-42',
    identifier: 'LIN-42',
    title: 'Ship the settings page',
    description: 'Parent body text',
    state: { name: 'In Progress', type: 'started' },
    priority: 2,
    assignee: null,
    team: { key: 'LIN', name: 'Linear', id: 'team-1' },
    labels: { nodes: [] },
    project: null,
    cycle: null,
    children: {
      nodes: [
        {
          identifier: 'LIN-43',
          title: 'Wire the toggle',
          state: { name: 'In Progress' },
        },
        {
          identifier: 'LIN-44',
          title: 'Write tests',
          state: { name: 'Todo' },
        },
      ],
    },
    url: 'https://linear.app/lini/issue/LIN-42/ship-the-settings-page',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function graphqlOk(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data }) } as Response;
}

/**
 * Stub global fetch as a Linear GraphQL endpoint serving every document the
 * #26 flows can issue. Returns captured requests for assertions. Any
 * unexpected document fails the stub loudly.
 */
function stubFetch(opts: StubOptions = {}): { requests: CapturedRequest[] } {
  const issue = opts.issue === undefined ? parentNode() : opts.issue;

  const requests: CapturedRequest[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest['body'];
    requests.push({ url: String(url), body });
    if (body.query.includes('query Issue(')) {
      return graphqlOk({ issue });
    }
    if (body.query.includes('query TeamByKey(')) {
      return graphqlOk({
        teams: { nodes: [{ id: 'team-1', key: 'LIN' }] },
      });
    }
    if (body.query.includes('mutation CreateIssue(')) {
      return graphqlOk({
        issueCreate: {
          success: true,
          issue: {
            id: 'ir-9',
            identifier: 'LIN-9',
            title: 'Wire the toggle',
            url: 'https://linear.app/lini/issue/LIN-9/wire-the-toggle',
          },
        },
      });
    }
    throw new Error(`Unexpected GraphQL document in stub: ${body.query}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests };
}

const createRequests = (requests: CapturedRequest[]) =>
  requests.filter((r) => r.body.query.includes('mutation CreateIssue('));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('issue create --parent', () => {
  it('resolves the parent ref to its id and sends parentId', async () => {
    const { requests } = stubFetch();

    const out = await issueCommand(
      [
        'create',
        '--title',
        'Wire the toggle',
        '--team',
        'LIN',
        '--parent',
        'LIN-42',
      ],
      { apiKey: FAKE_KEY },
    );

    // Parent resolution first, then team resolution, then the mutation.
    expect(requests).toHaveLength(3);
    expect(requests[0].body.query).toContain('query Issue(');
    expect(requests[0].body.variables).toEqual({ id: 'LIN-42' });
    const mutation = requests[2];
    expect(mutation.body.query).toContain('parentId: $parentId');
    expect(mutation.body.query).toContain('$parentId: String');
    expect(mutation.body.variables).toEqual({
      teamId: 'team-1',
      title: 'Wire the toggle',
      parentId: 'ir-42',
    });
    expect(out).toContain('created: LIN-9');
  });

  it('passes a UUID parent ref through the same resolution', async () => {
    const { requests } = stubFetch();

    await issueCommand(
      [
        'create',
        '--title',
        'Wire the toggle',
        '--team',
        'LIN',
        '--parent',
        PARENT_UUID,
      ],
      { apiKey: FAKE_KEY },
    );

    expect(requests[0].body.variables).toEqual({ id: PARENT_UUID });
    expect(createRequests(requests)[0]!.body.variables).toEqual({
      teamId: 'team-1',
      title: 'Wire the toggle',
      parentId: 'ir-42',
    });
  });

  it('fails loud when the parent is not found (no mutation)', async () => {
    const { requests } = stubFetch({ issue: null });

    await expect(
      issueCommand(
        [
          'create',
          '--title',
          'Wire the toggle',
          '--team',
          'LIN',
          '--parent',
          'LIN-404',
        ],
        { apiKey: FAKE_KEY },
      ),
    ).rejects.toThrow(/Parent issue "LIN-404" not found/);

    expect(createRequests(requests)).toHaveLength(0);
  });

  it('rejects a blank --parent before any network request', async () => {
    const { requests } = stubFetch();

    await expect(
      issueCommand(
        ['create', '--title', 'x', '--team', 'LIN', '--parent', ''],
        { apiKey: FAKE_KEY },
      ),
    ).rejects.toThrow(/--parent requires a value/);

    expect(requests).toHaveLength(0);
  });

  it('does not pre-reject a cross-team parent (Linear decides)', async () => {
    // Linear's sub-issue hierarchy spans teams, so the client sends the
    // parentId and lets the API answer — any rejection would surface through
    // the normal error mapping.
    const { requests } = stubFetch({
      issue: parentNode({
        team: { key: 'ENG', name: 'Engineering', id: 'team-eng' },
      }),
    });

    await issueCommand(
      [
        'create',
        '--title',
        'Wire the toggle',
        '--team',
        'LIN',
        '--parent',
        'ENG-7',
      ],
      { apiKey: FAKE_KEY },
    );

    const mutation = createRequests(requests)[0]!;
    expect(mutation.body.variables).toEqual({
      teamId: 'team-1',
      title: 'Wire the toggle',
      parentId: 'ir-42',
    });
  });

  it('sends no parentId without --parent (default document unchanged)', async () => {
    const { requests } = stubFetch();

    await issueCommand(['create', '--title', 'Ship v2', '--team', 'LIN'], {
      apiKey: FAKE_KEY,
    });

    // Only team resolution + mutation; no parent round trip.
    expect(requests).toHaveLength(2);
    const mutation = createRequests(requests)[0]!;
    expect(mutation.body.query).not.toContain('parentId');
    expect(mutation.body.variables).toEqual({
      teamId: 'team-1',
      title: 'Ship v2',
    });
  });
});

describe('issue view --full children', () => {
  it('selects the children connection and renders one line per child', async () => {
    const { requests } = stubFetch();

    const out = await issueCommand(['view', 'LIN-42', '--full'], {
      apiKey: FAKE_KEY,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.query).toContain(
      'children { nodes { identifier title state { name } } }',
    );
    expect(requests[0].body.variables).toEqual({ id: 'LIN-42' });
    // Count header plus one `identifier | title | state` line per child, in
    // server order.
    expect(out).toContain('sub-issues[2]:');
    expect(out).toContain('LIN-43 | Wire the toggle | In Progress');
    expect(out).toContain('LIN-44 | Write tests | Todo');
    expect(out.indexOf('LIN-43')).toBeLessThan(out.indexOf('LIN-44'));
  });

  it('omits the children selection and the block without --full', async () => {
    const { requests } = stubFetch();

    const out = await issueCommand(['view', 'LIN-42'], { apiKey: FAKE_KEY });

    // Default detail document stays byte-identical (opt-in only).
    expect(requests[0].body.query).not.toContain('children');
    expect(out).not.toContain('sub-issues');
  });

  it('renders an empty sub-issues header under --full', async () => {
    stubFetch({ issue: parentNode({ children: { nodes: [] } }) });

    const out = await issueCommand(['view', 'LIN-42', '--full'], {
      apiKey: FAKE_KEY,
    });

    expect(out).toContain('sub-issues[0]:');
  });
});

describe('help documents the sub-issue flags (#26)', () => {
  it('lists --parent on create and the --full children listing', () => {
    expect(ISSUE_HELP).toContain(
      '[--description "..."] [--label <name>...] [--project <name>] [--cycle <current|number>] [--parent <IDENTIFIER|UUID>]',
    );
    expect(ISSUE_HELP).toContain(
      '--parent <IDENTIFIER|UUID>   create: nest the new issue under this parent',
    );
    expect(ISSUE_HELP).toContain('--full (view)');
    expect(ISSUE_HELP).toContain(
      'linear-axi issue create --title "Wire the toggle" --team ENG --parent LIN-42',
    );
  });
});
