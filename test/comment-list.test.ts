// Tests for `comment list` (#19): reading an issue's comment thread through
// the root `comments` connection. Follows the network-free GraphQL stub
// pattern from cycles.test.ts / fields-wiring.test.ts: stub global fetch,
// then assert on the captured query documents (issue resolution first, then
// comments), variables, and rendered TOON output.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { commentCommand, COMMENT_HELP } from '../src/commands/comment.js';
import { fetchComments } from '../src/linear.js';
import { AxiError } from '../src/errors.js';
import type { LinearComment, LinearIssue } from '../src/linear.js';

const FAKE_KEY = 'lin_api_fake';

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO timestamp n days from now (negative = past) — keeps relative times stable. */
function daysFromNow(n: number): string {
  return new Date(Date.now() + n * DAY_MS).toISOString();
}

/** A minimal Linear issue node matching ISSUE_DETAIL_FIELDS. */
function issueNode(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'ir-1',
    identifier: 'LIN-1',
    title: 'Ship the thing',
    description: 'Body text',
    state: { name: 'Started', type: 'started' },
    priority: 2,
    assignee: { name: 'Ada' },
    team: { key: 'LIN', name: 'Linear', id: 'team-1' },
    labels: { nodes: [] },
    url: 'https://linear.app/lini/issue/LIN-1/ship-the-thing',
    createdAt: daysFromNow(-30),
    updatedAt: daysFromNow(-1),
    ...overrides,
  };
}

/** A minimal Linear comment node matching COMMENT_LIST_FIELDS. */
function commentNode(overrides: Partial<LinearComment> = {}): LinearComment {
  return {
    id: 'cm-1',
    body: 'Looks good to me',
    user: { name: 'Ada' },
    externalUser: null,
    createdAt: daysFromNow(-1),
    ...overrides,
  };
}

function graphqlOk(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data }) } as Response;
}

interface CapturedRequest {
  url: string;
  body: { query: string; variables: Record<string, unknown> };
}

/**
 * Stub global fetch as a Linear GraphQL endpoint. `thread` is served for the
 * `comments` query; `issue` (default: the LIN-1 node) for the `issue(...)`
 * resolution query; any mutation falls through to a commentCreate success.
 * Returns the captured requests for assertions.
 */
function stubLinearFetch(
  thread: { nodes: LinearComment[]; hasNextPage?: boolean },
  issue: LinearIssue | null = issueNode(),
): { requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest['body'];
    const captured: CapturedRequest = { url: String(url), body };
    requests.push(captured);
    if (body.query.includes('query Comments(')) {
      return graphqlOk({
        comments: {
          nodes: thread.nodes,
          pageInfo: {
            hasNextPage: thread.hasNextPage ?? false,
            endCursor: null,
          },
        },
      });
    }
    if (body.query.includes('query Issue(')) {
      return graphqlOk({ issue });
    }
    return graphqlOk({ commentCreate: { success: true } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('comment dispatch', () => {
  it('routes `comment list <ref>` to the comments query', async () => {
    const { requests } = stubLinearFetch({
      nodes: [commentNode()],
    });

    const out = await commentCommand(['list', 'LIN-1'], {
      apiKey: FAKE_KEY,
    });

    // Two round trips: resolve the ref to the issue, then its comments.
    expect(requests).toHaveLength(2);
    expect(requests[0].body.query).toContain('query Issue(');
    expect(requests[0].body.variables).toEqual({ id: 'LIN-1' });
    expect(requests[1].body.query).toContain('query Comments(');
    expect(out).toContain('count: 1');
    expect(out).toContain('Ada');
  });

  it('keeps bare `comment <ref> --body` on the create path (backward compat)', async () => {
    const { requests } = stubLinearFetch({ nodes: [] });

    const out = await commentCommand(['LIN-1', '--body', 'hello'], {
      apiKey: FAKE_KEY,
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].body.query).toContain('query Issue(');
    expect(requests[1].body.query).toContain('mutation Comment(');
    expect(requests[1].body.variables).toEqual({
      issueId: 'ir-1',
      body: 'hello',
    });
    expect(out).toContain('comment: added to LIN-1');
    // The create path must not leak list output.
    expect(out).not.toContain('comments[0]');
  });
});

describe('comment list document', () => {
  it('scopes the root comments connection by issue id, newest first', async () => {
    const { requests } = stubLinearFetch({ nodes: [commentNode()] });

    await commentCommand(['list', 'LIN-1'], { apiKey: FAKE_KEY });

    const query = requests[1].body.query;
    expect(requests[1].url).toBe('https://api.linear.app/graphql');
    expect(query).toContain(
      'comments(filter: { issue: { id: { eq: $issueId } } }, first: $first, after: $after, orderBy: createdAt)',
    );
    // Requested node fields: body, author, creation time.
    expect(query).toContain('body');
    expect(query).toContain('user { name }');
    expect(query).toContain('createdAt');
    expect(requests[1].body.variables).toEqual({ issueId: 'ir-1', first: 50 });
  });
});

describe('comment list rendering', () => {
  it('renders the thread newest-first in the server order', async () => {
    const oldest = commentNode({
      id: 'cm-1',
      body: 'oldest comment',
      user: { name: 'Older' },
      createdAt: daysFromNow(-10),
    });
    const middle = commentNode({
      id: 'cm-2',
      body: 'middle comment',
      user: { name: 'Middler' },
      createdAt: daysFromNow(-3),
    });
    const newest = commentNode({
      id: 'cm-3',
      body: 'newest comment',
      user: { name: 'Newer' },
      createdAt: daysFromNow(-1),
    });
    // The connection returns newest-first (orderBy: createdAt, descending) —
    // the CLI renders nodes as-is with no client-side reordering.
    stubLinearFetch({ nodes: [newest, middle, oldest] });

    const out = await commentCommand(['list', 'LIN-1'], {
      apiKey: FAKE_KEY,
    });

    expect(out).toContain('comments[3]{id,author,body,created}');
    expect(out).toContain('newest comment');
    expect(out).toContain('middle comment');
    expect(out).toContain('oldest comment');
    // Newest row before middle before oldest.
    expect(out.indexOf('newest comment')).toBeLessThan(
      out.indexOf('middle comment'),
    );
    expect(out.indexOf('middle comment')).toBeLessThan(
      out.indexOf('oldest comment'),
    );
    expect(out).toContain('count: 3');
    // Relative creation times per row.
    expect(out).toContain('1d ago');
    expect(out).toContain('3d ago');
    expect(out).toContain('10d ago');
    // Reply hint points at the create syntax on the resolved identifier.
    expect(out).toContain('comment LIN-1 --body "..."');
  });

  it('falls back to externalUser displayName for integration comments', async () => {
    stubLinearFetch({
      nodes: [
        commentNode({
          body: 'from slack',
          user: null,
          externalUser: { displayName: 'Slack Guest' },
        }),
        commentNode({ id: 'cm-2', body: 'from a bot', user: null }),
      ],
    });

    const out = await commentCommand(['list', 'LIN-1'], {
      apiKey: FAKE_KEY,
    });

    expect(out).toContain('Slack Guest');
    expect(out).toContain('unknown'); // bot comment without a user association
  });

  it('truncates long bodies to a 200-char preview with a total-size note', async () => {
    const long = `${'x'.repeat(250)}TAILMARKER`;
    stubLinearFetch({ nodes: [commentNode({ body: long })] });

    const out = await commentCommand(['list', 'LIN-1'], {
      apiKey: FAKE_KEY,
    });

    expect(out).toContain('...'); // truncateForDisplay ellipsis
    expect(out).toContain(`(${long.length} chars total)`);
    expect(out).not.toContain('TAILMARKER'); // tail is cut
    // Escape hatch is advertised.
    expect(out).toContain('comment list LIN-1 --full');
  });

  it('shows full bodies with --full (no truncation)', async () => {
    const long = `${'x'.repeat(250)}TAILMARKER`;
    stubLinearFetch({ nodes: [commentNode({ body: long })] });

    const out = await commentCommand(['list', 'LIN-1', '--full'], {
      apiKey: FAKE_KEY,
    });

    expect(out).toContain('TAILMARKER');
    expect(out).not.toContain('chars total)');
    expect(out).not.toContain('--full'); // no truncation hint when untruncated
  });

  it('renders a definitive empty state with count line and a start-thread hint', async () => {
    stubLinearFetch({ nodes: [] });

    const out = await commentCommand(['list', 'LIN-1'], {
      apiKey: FAKE_KEY,
    });

    expect(out).toContain('count: 0');
    expect(out).toContain('comments: 0 found');
    expect(out).toContain('start the thread');
    expect(out).not.toContain('comments[0]');
  });
});

describe('comment list failures', () => {
  it('fails loud when the issue ref does not resolve', async () => {
    const { requests } = stubLinearFetch({ nodes: [] }, null);

    const err = await commentCommand(['list', 'LIN-404'], {
      apiKey: FAKE_KEY,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe('NOT_FOUND');
    expect((err as AxiError).message).toContain('LIN-404');
    // Only the resolution query fired — no comments query for a dead ref.
    expect(requests).toHaveLength(1);
  });

  it('requires a ref after the subcommand', async () => {
    const err = await commentCommand(['list'], { apiKey: FAKE_KEY }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe('VALIDATION_ERROR');
    expect((err as AxiError).message).toContain('Missing issue reference');
  });

  it('rejects unknown flags on the list path', async () => {
    const err = await commentCommand(['list', 'LIN-1', '--bogus'], {
      apiKey: FAKE_KEY,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe('VALIDATION_ERROR');
    expect((err as AxiError).message).toContain('unknown flag --bogus');
  });

  it('rejects create-only flags on the list path and list-only flags on the create path', async () => {
    const listWithBody = await commentCommand(
      ['list', 'LIN-1', '--body', 'x'],
      { apiKey: FAKE_KEY },
    ).catch((e: unknown) => e);
    expect(listWithBody).toBeInstanceOf(AxiError);
    expect((listWithBody as AxiError).message).toContain('unknown flag --body');

    const createWithFull = await commentCommand(
      ['LIN-1', '--body', 'x', '--full'],
      { apiKey: FAKE_KEY },
    ).catch((e: unknown) => e);
    expect(createWithFull).toBeInstanceOf(AxiError);
    expect((createWithFull as AxiError).message).toContain(
      'unknown flag --full',
    );
  });
});

describe('fetchComments pagination', () => {
  it('follows the cursor until the limit is met and reports hasMore', async () => {
    const requests: CapturedRequest[] = [];
    const page = (id: string) =>
      commentNode({ id, body: `comment ${id}`, createdAt: daysFromNow(-1) });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as CapturedRequest['body'];
      requests.push({ url: String(_url), body });
      if (body.variables['after'] === undefined) {
        return graphqlOk({
          comments: {
            nodes: Array.from({ length: 50 }, (_, i) => page(`a${i}`)),
            pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
          },
        });
      }
      return graphqlOk({
        comments: {
          nodes: Array.from({ length: 50 }, (_, i) => page(`b${i}`)),
          pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { comments, hasMore } = await fetchComments(
      FAKE_KEY,
      'ir-1',
      100, // limit satisfied after two 50-node pages
    );

    expect(comments).toHaveLength(100);
    expect(hasMore).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0].body.variables).toEqual({ issueId: 'ir-1', first: 50 });
    expect(requests[1].body.variables).toEqual({
      issueId: 'ir-1',
      first: 50,
      after: 'cursor-1',
    });
  });
});

describe('comment help', () => {
  it('documents the list subcommand and --full', () => {
    expect(COMMENT_HELP).toContain('comment list <IDENTIFIER|UUID> [--full]');
    expect(COMMENT_HELP).toContain('newest first');
    expect(COMMENT_HELP).toContain('200-char previews');
    expect(COMMENT_HELP).toContain('linear-axi comment list LIN-123 --full');
    // The create usage line stays first (backward compat).
    expect(COMMENT_HELP.indexOf('--body "..."')).toBeLessThan(
      COMMENT_HELP.indexOf('comment list'),
    );
  });
});
