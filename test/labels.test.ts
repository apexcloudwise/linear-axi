// Tests for the `labels` command (#22): listing workspace issue labels
// through the root `issueLabels` connection. Follows the network-free GraphQL
// stub pattern from projects.test.ts / comment-list.test.ts: stub global
// fetch, then assert on the captured query document, variables, and rendered
// TOON output.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { labelsCommand, LABELS_HELP } from '../src/commands/labels.js';
import { issueCommand } from '../src/commands/issue.js';
import { fetchLabels } from '../src/linear.js';
import type { LinearLabel } from '../src/linear.js';

const FAKE_KEY = 'lin_api_fake';

interface CapturedRequest {
  url: string;
  body: { query: string; variables: Record<string, unknown> };
}

interface LabelPage {
  nodes: LinearLabel[];
  hasNextPage?: boolean;
  endCursor?: string | null;
}

/** A minimal Linear label node matching LABEL_LIST_FIELDS. */
function labelNode(overrides: Partial<LinearLabel> = {}): LinearLabel {
  return {
    id: 'lb-1',
    name: 'bug',
    color: '#EB5757',
    ...overrides,
  };
}

function graphqlOk(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data }) } as Response;
}

/**
 * Stub global fetch as a Linear GraphQL endpoint serving `pages` of labels
 * sequentially (the i-th `query Labels(` request gets pages[i]; requests
 * beyond the list get the last page). Returns the captured requests for
 * assertions.
 */
function stubLabelFetch(pages: LabelPage[]): {
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  let labelsCall = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest['body'];
    requests.push({ url: String(url), body });
    if (body.query.includes('query Labels(')) {
      const page = pages[Math.min(labelsCall, pages.length - 1)]!;
      labelsCall += 1;
      return graphqlOk({
        issueLabels: {
          nodes: page.nodes,
          pageInfo: {
            hasNextPage: page.hasNextPage ?? false,
            endCursor: page.endCursor ?? null,
          },
        },
      });
    }
    return graphqlOk({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('labels command document', () => {
  it('requests id, name, and color workspace-wide, newest-updated first', async () => {
    const { requests } = stubLabelFetch([{ nodes: [labelNode()] }]);

    await labelsCommand([], { apiKey: FAKE_KEY });

    const query = requests[0].body.query;
    expect(requests[0].url).toBe('https://api.linear.app/graphql');
    expect(query).toContain(
      'issueLabels(first: $first, after: $after, orderBy: updatedAt)',
    );
    // Requested node fields: id, name, and the raw HEX color.
    expect(query).toContain('id');
    expect(query).toContain('name');
    expect(query).toContain('color');
    expect(query).toContain('pageInfo { hasNextPage endCursor }');
    expect(requests[0].body.variables).toEqual({ first: 50 });
  });
});

describe('labels rendering', () => {
  it('renders name and raw HEX color rows with a count line', async () => {
    stubLabelFetch([
      {
        nodes: [
          labelNode({ id: 'lb-bug', name: 'bug', color: '#EB5757' }),
          labelNode({ id: 'lb-feat', name: 'feature', color: '#4CB782' }),
          labelNode({ id: 'lb-chore', name: 'chore', color: '#95A2B3' }),
        ],
      },
    ]);

    const out = await labelsCommand([], { apiKey: FAKE_KEY });

    expect(out).toContain('labels[3]{name,color}');
    expect(out).toContain('bug');
    expect(out).toContain('#EB5757'); // raw hex, no ANSI swatch
    expect(out).toContain('feature');
    expect(out).toContain('#4CB782');
    expect(out).toContain('chore');
    expect(out).toContain('#95A2B3');
    expect(out).toContain('count: 3');
  });

  it('flags a truncated slice when more labels exist past the cursor', async () => {
    // Page 1 reports hasNextPage and the follow-up page comes back empty —
    // the empty-page loop guard stops the fetch with hasMore still true.
    stubLabelFetch([
      {
        nodes: [labelNode(), labelNode({ id: 'lb-2', name: 'chore' })],
        hasNextPage: true,
        endCursor: 'c1',
      },
      { nodes: [], hasNextPage: true, endCursor: 'c2' },
    ]);

    const out = await labelsCommand([], { apiKey: FAKE_KEY });

    expect(out).toContain('count: 2 (showing first 2)');
  });

  it('renders a definitive empty state when the workspace has no labels', async () => {
    stubLabelFetch([{ nodes: [] }]);

    const out = await labelsCommand([], { apiKey: FAKE_KEY });

    expect(out).toContain('count: 0');
    expect(out).toContain('labels: 0 found');
    expect(out).toContain('Create a label in the Linear app');
    expect(out).not.toContain('labels[0]');
  });

  it('hints at issues --label and issue create --label', async () => {
    stubLabelFetch([{ nodes: [labelNode()] }]);

    const out = await labelsCommand([], { apiKey: FAKE_KEY });

    expect(out).toContain('issues --label');
    expect(out).toContain('issue create --label');
  });
});

describe('labels pagination', () => {
  it('follows the cursor until the limit is met and reports hasMore', async () => {
    const page = (prefix: string) =>
      Array.from({ length: 50 }, (_, i) =>
        labelNode({ id: `${prefix}${i}`, name: `label ${prefix}${i}` }),
      );
    const { requests } = stubLabelFetch([
      { nodes: page('a'), hasNextPage: true, endCursor: 'cursor-1' },
      { nodes: page('b'), hasNextPage: true, endCursor: 'cursor-2' },
    ]);

    const { labels, hasMore } = await fetchLabels(
      FAKE_KEY,
      100, // limit satisfied after two 50-node pages
    );

    expect(labels).toHaveLength(100);
    expect(labels[0]!.name).toBe('label a0');
    expect(labels[99]!.name).toBe('label b49');
    expect(hasMore).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0].body.variables).toEqual({ first: 50 });
    expect(requests[1].body.variables).toEqual({
      first: 50,
      after: 'cursor-1',
    });
  });

  it('auto-paginates in 50-size batches until the server is exhausted', async () => {
    const { requests } = stubLabelFetch([
      {
        nodes: Array.from({ length: 50 }, (_, i) =>
          labelNode({ id: `lb-${i}`, name: `label ${i}` }),
        ),
        hasNextPage: true,
        endCursor: 'c1',
      },
      {
        nodes: [
          labelNode({ id: 'lb-50', name: 'label 50' }),
          labelNode({ id: 'lb-51', name: 'label 51' }),
        ],
        hasNextPage: false,
        endCursor: null,
      },
    ]);

    const { labels, hasMore } = await fetchLabels(FAKE_KEY); // default limit

    expect(requests).toHaveLength(2);
    expect(requests[1].body.variables).toEqual({ first: 50, after: 'c1' });
    expect(labels).toHaveLength(52);
    expect(labels[51]!.name).toBe('label 51');
    expect(hasMore).toBe(false);
  });
});

describe('labels failures', () => {
  it('rejects unknown flags loudly (no flags are valid)', async () => {
    stubLabelFetch([{ nodes: [] }]);

    await expect(
      labelsCommand(['--bogus'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/unknown flag --bogus/);
  });

  it('rejects positional arguments loudly', async () => {
    await expect(labelsCommand(['extra'], { apiKey: FAKE_KEY })).rejects.toThrow(
      /Unexpected argument: extra/,
    );
  });
});

describe('label resolution reuse', () => {
  it('resolves issue create --label names through the paginated labels query', async () => {
    // The create path (createIssue -> resolveLabelIds) reuses fetchLabels:
    // team resolution, then the Labels query, then the CreateIssue mutation.
    const requests: CapturedRequest[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as CapturedRequest['body'];
      requests.push({ url: String(url), body });
      if (body.query.includes('query TeamByKey(')) {
        return graphqlOk({
          teams: { nodes: [{ id: 'team-1', key: 'LIN' }] },
        });
      }
      if (body.query.includes('query Labels(')) {
        return graphqlOk({
          issueLabels: {
            nodes: [
              labelNode({ id: 'lb-bug', name: 'Bug' }),
              labelNode({ id: 'lb-feat', name: 'feature' }),
              labelNode({ id: 'lb-chore', name: 'chore' }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        });
      }
      return graphqlOk({
        issueCreate: {
          success: true,
          issue: {
            id: 'ir-9',
            identifier: 'LIN-9',
            title: 'T',
            url: 'https://linear.app/lini/issue/LIN-9/t',
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await issueCommand(
      [
        'create',
        '--title',
        'T',
        '--team',
        'LIN',
        '--label',
        'BUG',
        '--label',
        'feature',
      ],
      { apiKey: FAKE_KEY },
    );

    // Three round trips: team key, labels, mutation.
    expect(requests).toHaveLength(3);
    expect(requests[1].body.query).toContain(
      'issueLabels(first: $first, after: $after, orderBy: updatedAt)',
    );
    // Matching stays case-insensitive and yields ids in server order.
    expect(requests[2].body.variables).toEqual({
      teamId: 'team-1',
      title: 'T',
      labelIds: ['lb-bug', 'lb-feat'],
    });
    expect(out).toContain('created: LIN-9');
  });
});

describe('labels help', () => {
  it('documents the columns and both label flags', () => {
    expect(LABELS_HELP).toContain('usage: linear-axi labels');
    expect(LABELS_HELP).toContain(
      'color label color as a raw HEX string (e.g. #EB5757)',
    );
    expect(LABELS_HELP).toContain('linear-axi issues --label bug');
    expect(LABELS_HELP).toContain(
      'issue create --title "Fix login" --team ENG --label bug',
    );
  });
});
