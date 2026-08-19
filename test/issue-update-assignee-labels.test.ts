// Tests for `issue update --assignee / --label / --remove-label` (#24).
// Follows the network-free GraphQL stub pattern from labels.test.ts /
// comment-list.test.ts: stub global fetch, then assert on the captured query
// documents, mutation variables, and rendered TOON output. Update flow order:
// resolve the ref (query Issue), resolve the assignee (viewer for "me",
// UserByName otherwise), resolve added label names (query Labels), mutate.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { issueCommand, ISSUE_HELP } from '../src/commands/issue.js';
import type { AxiError } from '../errors.js';
import type { LinearIssue, LinearLabel } from '../src/linear.js';

const FAKE_KEY = 'lin_api_fake';

interface CapturedRequest {
  url: string;
  body: { query: string; variables: Record<string, unknown> };
}

interface StubUser {
  id: string;
  name: string;
  email: string;
}

interface StubOptions {
  /** The issue served for `query Issue(` (default: LIN-1, unassigned). */
  issue?: LinearIssue | null;
  /** Users served for `query UserByName(` (default: one Ada Lovelace). */
  users?: StubUser[];
  /** Viewer served for the `viewer { ... }` query (default: Sam the viewer). */
  viewer?: StubUser | null;
  /** Labels served for `query Labels(` (default: bug + feature). */
  labels?: LinearLabel[];
}

function issueNode(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'ir-1',
    identifier: 'LIN-1',
    title: 'Ship the thing',
    description: 'Body text',
    state: { name: 'Todo', type: 'unstarted' },
    priority: 2,
    assignee: null,
    team: { key: 'LIN', name: 'Linear', id: 'team-1' },
    labels: { nodes: [] },
    url: 'https://linear.app/lini/issue/LIN-1/ship-the-thing',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

const DEFAULT_VIEWER: StubUser = {
  id: 'user-viewer',
  name: 'Sam Viewer',
  email: 'sam@example.com',
};

const DEFAULT_USERS: StubUser[] = [
  { id: 'user-ada', name: 'Ada Lovelace', email: 'ada@example.com' },
];

const DEFAULT_LABELS: LinearLabel[] = [
  { id: 'lb-bug', name: 'bug', color: '#EB5757' },
  { id: 'lb-feat', name: 'feature', color: '#4CB782' },
];

function graphqlOk(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data }) } as Response;
}

/**
 * Stub global fetch as a Linear GraphQL endpoint serving every document the
 * update flow can issue. Returns the captured requests for assertions.
 */
function stubUpdateFetch(opts: StubOptions = {}): {
  requests: CapturedRequest[];
} {
  const issue = opts.issue === undefined ? issueNode() : opts.issue;
  const users = opts.users ?? DEFAULT_USERS;
  const viewer = opts.viewer === undefined ? DEFAULT_VIEWER : opts.viewer;
  const labels = opts.labels ?? DEFAULT_LABELS;

  const requests: CapturedRequest[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest['body'];
    requests.push({ url: String(url), body });
    if (body.query.includes('query Issue(')) {
      return graphqlOk({ issue });
    }
    if (body.query.includes('viewer {')) {
      return graphqlOk({ viewer });
    }
    if (body.query.includes('query UserByName(')) {
      return graphqlOk({ users: { nodes: users } });
    }
    if (body.query.includes('query Labels(')) {
      return graphqlOk({
        issueLabels: {
          nodes: labels,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
    }
    return graphqlOk({
      issueUpdate: {
        success: true,
        issue: {
          id: 'ir-1',
          identifier: 'LIN-1',
          title: 'Ship the thing',
          url: 'https://linear.app/lini/issue/LIN-1/ship-the-thing',
        },
      },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests };
}

const mutationRequests = (requests: CapturedRequest[]) =>
  requests.filter((r) => r.body.query.includes('mutation UpdateIssue('));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('issue update --assignee', () => {
  it('resolves "me" to the viewer id and sends only assigneeId', async () => {
    const { requests } = stubUpdateFetch();

    const out = await issueCommand(['update', 'LIN-1', '--assignee', 'me'], {
      apiKey: FAKE_KEY,
    });

    // Issue resolution, then viewer, then the mutation.
    expect(requests).toHaveLength(3);
    expect(requests[1].body.query).toContain('viewer { id name email }');
    const mutation = requests[2];
    expect(mutation.body.query).toContain('assigneeId: $assigneeId');
    // Omit-null builder: only the fields that changed are declared/sent.
    expect(mutation.body.query).toContain(
      'mutation UpdateIssue($id: String!, $assigneeId: String)',
    );
    expect(mutation.body.query).not.toContain('labelIds');
    expect(mutation.body.query).not.toContain('$title');
    expect(mutation.body.variables).toEqual({
      id: 'ir-1',
      assigneeId: 'user-viewer',
    });
    expect(out).toContain('updated: LIN-1');
  });

  it('resolves a named assignee through users(filter: { name: { eq } })', async () => {
    const { requests } = stubUpdateFetch();

    await issueCommand(['update', 'LIN-1', '--assignee', 'Ada Lovelace'], {
      apiKey: FAKE_KEY,
    });

    expect(requests).toHaveLength(3);
    expect(requests[1].body.query).toContain(
      'users(filter: { name: { eq: $name } })',
    );
    expect(requests[1].body.query).toContain('nodes { id name email }');
    expect(requests[1].body.variables).toEqual({ name: 'Ada Lovelace' });
    expect(requests[2].body.variables).toEqual({
      id: 'ir-1',
      assigneeId: 'user-ada',
    });
  });

  it('fails loud when the assignee name matches no user', async () => {
    const { requests } = stubUpdateFetch({ users: [] });

    await expect(
      issueCommand(['update', 'LIN-1', '--assignee', 'Nobody'], {
        apiKey: FAKE_KEY,
      }),
    ).rejects.toThrow(/User "Nobody" not found/);

    expect(mutationRequests(requests)).toHaveLength(0);
  });

  it('fails loud listing candidates when the name is ambiguous', async () => {
    const { requests } = stubUpdateFetch({
      users: [
        { id: 'user-ada-1', name: 'Ada Lovelace', email: 'ada@example.com' },
        { id: 'user-ada-2', name: 'Ada Lovelace', email: 'ada2@example.com' },
      ],
    });

    await expect(
      issueCommand(['update', 'LIN-1', '--assignee', 'Ada Lovelace'], {
        apiKey: FAKE_KEY,
      }),
    ).rejects.toThrow(/matches 2 users/);

    const err = await issueCommand(
      ['update', 'LIN-1', '--assignee', 'Ada Lovelace'],
      { apiKey: FAKE_KEY },
    ).catch((e: AxiError) => e);
    expect(err.suggestions.join(' ')).toContain('ada@example.com');
    expect(err.suggestions.join(' ')).toContain('ada2@example.com');
    expect(mutationRequests(requests)).toHaveLength(0);
  });

  it('reports re-assigning the current assignee as a no-op (no mutation)', async () => {
    const { requests } = stubUpdateFetch({
      issue: issueNode({ assignee: { name: 'Ada Lovelace' } }),
    });

    const out = await issueCommand(
      ['update', 'LIN-1', '--assignee', 'ada lovelace'],
      { apiKey: FAKE_KEY },
    );

    expect(out).toContain('(no-op)');
    expect(mutationRequests(requests)).toHaveLength(0);
  });

  it('reports --assignee me as a no-op when the viewer is assigned', async () => {
    const { requests } = stubUpdateFetch({
      issue: issueNode({ assignee: { name: 'Sam Viewer' } }),
    });

    const out = await issueCommand(['update', 'LIN-1', '--assignee', 'me'], {
      apiKey: FAKE_KEY,
    });

    expect(out).toContain('(no-op)');
    expect(mutationRequests(requests)).toHaveLength(0);
  });
});

describe('issue update --label / --remove-label', () => {
  it('unions resolved --label ids with the current label ids', async () => {
    const { requests } = stubUpdateFetch({
      issue: issueNode({
        labels: { nodes: [{ id: 'lb-feat', name: 'feature' }] },
      }),
    });

    const out = await issueCommand(['update', 'LIN-1', '--label', 'bug'], {
      apiKey: FAKE_KEY,
    });

    // Issue resolution, label-name resolution (reuse of fetchLabels), mutate.
    expect(requests).toHaveLength(3);
    expect(requests[1].body.query).toContain(
      'issueLabels(first: $first, after: $after, orderBy: updatedAt)',
    );
    const mutation = requests[2];
    expect(mutation.body.query).toContain('labelIds: $labelIds');
    expect(mutation.body.query).toContain('$labelIds: [String!]');
    // Current ids first, resolved additions after — the full replacement set.
    expect(mutation.body.variables).toEqual({
      id: 'ir-1',
      labelIds: ['lb-feat', 'lb-bug'],
    });
    expect(out).toContain('updated: LIN-1');
  });

  it("removes one of two labels by matching the issue's own label names", async () => {
    const { requests } = stubUpdateFetch({
      issue: issueNode({
        labels: {
          nodes: [
            { id: 'lb-bug', name: 'bug' },
            { id: 'lb-feat', name: 'feature' },
          ],
        },
      }),
    });

    await issueCommand(['update', 'LIN-1', '--remove-label', 'BUG'], {
      apiKey: FAKE_KEY,
    });

    // Removal matches against the issue's own labels — no workspace labels
    // round trip, just resolve + mutate. Case-insensitive name match.
    expect(requests).toHaveLength(2);
    expect(requests[1].body.variables).toEqual({
      id: 'ir-1',
      labelIds: ['lb-feat'],
    });
  });

  it('sends labelIds: [] explicitly when the LAST label is removed', async () => {
    const { requests } = stubUpdateFetch({
      issue: issueNode({
        labels: { nodes: [{ id: 'lb-bug', name: 'bug' }] },
      }),
    });

    const out = await issueCommand(
      ['update', 'LIN-1', '--remove-label', 'bug'],
      { apiKey: FAKE_KEY },
    );

    const mutation = requests[1];
    // The field must be INCLUDED with an empty array — an omitted labelIds
    // would leave the label in place (Linear replaces the whole set).
    expect(mutation.body.query).toContain('labelIds: $labelIds');
    expect(mutation.body.variables).toEqual({ id: 'ir-1', labelIds: [] });
    expect(out).toContain('updated: LIN-1');
  });

  it('reports a label set that already matches as a no-op (no mutation)', async () => {
    const { requests } = stubUpdateFetch({
      issue: issueNode({
        labels: { nodes: [{ id: 'lb-bug', name: 'bug' }] },
      }),
    });

    const out = await issueCommand(['update', 'LIN-1', '--label', 'bug'], {
      apiKey: FAKE_KEY,
    });

    expect(out).toContain('(no-op)');
    expect(mutationRequests(requests)).toHaveLength(0);
  });

  it('treats removing a label the issue does not carry as a no-op', async () => {
    const { requests } = stubUpdateFetch({
      issue: issueNode({
        labels: { nodes: [{ id: 'lb-bug', name: 'bug' }] },
      }),
    });

    const out = await issueCommand(
      ['update', 'LIN-1', '--remove-label', 'feature'],
      { apiKey: FAKE_KEY },
    );

    expect(out).toContain('(no-op)');
    expect(mutationRequests(requests)).toHaveLength(0);
  });
});

describe('issue update acceptance and guards', () => {
  it('applies --assignee me --label bug together (acceptance case)', async () => {
    const { requests } = stubUpdateFetch();

    const out = await issueCommand(
      ['update', 'LIN-1', '--assignee', 'me', '--label', 'bug'],
      { apiKey: FAKE_KEY },
    );

    // Resolve ref, resolve viewer, resolve label names, mutate.
    expect(requests).toHaveLength(4);
    expect(requests[3].body.variables).toEqual({
      id: 'ir-1',
      assigneeId: 'user-viewer',
      labelIds: ['lb-bug'],
    });
    expect(out).toContain('updated: LIN-1');
  });

  it('still rejects an update with nothing to do, listing every flag', async () => {
    const { requests } = stubUpdateFetch();

    await expect(
      issueCommand(['update', 'LIN-1'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/Nothing to update/);

    // The guard fires before any network request.
    expect(requests).toHaveLength(0);
  });

  it('rejects blank --label and --assignee values loudly', async () => {
    stubUpdateFetch();
    await expect(
      issueCommand(['update', 'LIN-1', '--label', ''], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/--label requires a value/);
    await expect(
      issueCommand(['update', 'LIN-1', '--assignee', ''], {
        apiKey: FAKE_KEY,
      }),
    ).rejects.toThrow(/--assignee requires a value/);
  });

  it('documents the new flags in help', () => {
    expect(ISSUE_HELP).toContain('[--assignee <name|me>]');
    expect(ISSUE_HELP).toContain('[--label <name>]');
    expect(ISSUE_HELP).toContain('[--remove-label <name>]');
    expect(ISSUE_HELP).toContain(
      'linear-axi issue update LIN-123 --assignee me --label bug',
    );
    expect(ISSUE_HELP).toContain(
      'linear-axi issue update LIN-123 --remove-label bug',
    );
  });
});
