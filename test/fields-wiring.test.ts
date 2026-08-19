// Tests for the `--fields` opt-in extra fields wiring (#23): `issues
// --fields <a,b,c>` and `issue view <ref> --fields <a,b,c>`. Follows the
// network-free GraphQL stub pattern from cycles.test.ts: stub global fetch,
// then assert on the captured query document (extra keys present only when
// requested), variables, and rendered TOON output (extra columns/rows).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { issuesCommand, ISSUES_HELP } from '../src/commands/issues.js';
import { issueCommand, ISSUE_HELP } from '../src/commands/issue.js';
import { AxiError } from '../src/errors.js';
import type { LinearIssue } from '../src/linear.js';

const FAKE_KEY = 'lin_api_fake';

/** A minimal Linear issue node matching ISSUE_LIST_FIELDS (+ extras when given). */
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

/** A minimal Linear issue node matching ISSUE_DETAIL_FIELDS (+ extras when given). */
function detailNode(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'ir-1',
    identifier: 'LIN-1',
    title: 'Ship the thing',
    description: 'Body text',
    state: { name: 'Started', type: 'started' },
    priority: 2,
    assignee: { name: 'Ada' },
    team: { key: 'LIN', name: 'Linear', id: 'team-1' },
    labels: { nodes: [{ name: 'bug' }] },
    url: 'https://linear.app/lini/issue/LIN-1/ship-the-thing',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
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

describe('issues --fields', () => {
  it('adds the requested key to the issued document and a url column to the output', async () => {
    const { requests } = stubLinearFetch(() => ({
      issues: {
        nodes: [issueNode({ url: 'https://linear.app/lini/issue/LIN-1/ship' })],
      },
    }));

    const out = await issuesCommand(['--fields', 'url'], {
      apiKey: FAKE_KEY,
    });

    const query = requests[0].body.query;
    expect(query).toContain('query Issues(');
    // The extra key rides along after the base selection fields.
    expect(query).toContain('updatedAt');
    expect(query).toMatch(/\n\s+url/);
    expect(out).toContain('LIN-1');
    expect(out).toContain('https://linear.app/lini/issue/LIN-1/ship');
    expect(out).toContain('url'); // column key present in the TOON table
  });

  it('accepts multiple comma-separated fields (url,estimate)', async () => {
    const { requests } = stubLinearFetch(() => ({
      issues: {
        nodes: [
          issueNode({
            url: 'https://linear.app/lini/issue/LIN-1/ship',
            estimate: 3,
          }),
        ],
      },
    }));

    const out = await issuesCommand(['--fields', 'url,estimate'], {
      apiKey: FAKE_KEY,
    });

    const query = requests[0].body.query;
    expect(query).toMatch(/\n\s+url/);
    expect(query).toMatch(/\n\s+estimate/);
    expect(out).toContain('https://linear.app/lini/issue/LIN-1/ship');
    expect(out).toContain('3');
    expect(out).toContain('estimate');
  });

  it('composes with an existing filter (--team)', async () => {
    const { requests } = stubLinearFetch(() => ({
      issues: { nodes: [issueNode({ dueDate: '2026-09-01' })] },
    }));

    const out = await issuesCommand(['--team', 'LIN', '--fields', 'dueDate'], {
      apiKey: FAKE_KEY,
    });

    const query = requests[0].body.query;
    expect(query).toContain('team: { key: { eq: "LIN" } }');
    expect(query).toMatch(/\n\s+dueDate/);
    expect(out).toContain('2026-09-01');
    expect(out).toContain('dueDate');
  });

  it('applies extras to the searchIssues document too (--search)', async () => {
    const { requests } = stubLinearFetch(() => ({
      searchIssues: {
        nodes: [
          issueNode({
            url: 'https://linear.app/lini/issue/LIN-1/ship',
            estimate: 5,
          }),
        ],
      },
    }));

    const out = await issuesCommand(
      ['--search', 'onboarding', '--fields', 'url,estimate'],
      { apiKey: FAKE_KEY },
    );

    const query = requests[0].body.query;
    expect(query).toContain('searchIssues(');
    expect(query).toMatch(/\n\s+url/);
    expect(query).toMatch(/\n\s+estimate/);
    expect(requests[0].body.variables).toEqual({
      term: 'onboarding',
      first: 25,
    });
    expect(out).toContain('https://linear.app/lini/issue/LIN-1/ship');
    expect(out).toContain('5');
  });

  it('leaves the default document and output untouched when the flag is absent', async () => {
    const { requests } = stubLinearFetch(() => ({
      issues: { nodes: [issueNode()] },
    }));

    const out = await issuesCommand([], { apiKey: FAKE_KEY });

    const query = requests[0].body.query;
    expect(query).toContain('query Issues(');
    // None of the opt-in keys may leak into the default selection.
    expect(query).not.toMatch(/\n\s+url/);
    expect(query).not.toMatch(/\n\s+estimate/);
    expect(query).not.toMatch(/\n\s+dueDate/);
    expect(query).not.toMatch(/\n\s+createdAt/);
    expect(out).toContain('LIN-1');
    expect(out).not.toContain('url:');
  });

  it('rejects unknown field names loudly with the valid set (no request sent)', async () => {
    const { requests } = stubLinearFetch(() => ({}));

    const err = await issuesCommand(['--fields', 'bogus'], {
      apiKey: FAKE_KEY,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe('VALIDATION_ERROR');
    expect((err as AxiError).message).toContain('Unknown field(s): bogus');
    expect((err as AxiError).message).toContain('url');
    expect((err as AxiError).message).toContain('estimate');
    expect((err as AxiError).message).toContain('dueDate');
    expect((err as AxiError).message).toContain('createdAt');
    expect(requests).toHaveLength(0); // fails before any network call
  });

  it('tolerates a blank value and blank names as "no extras"', async () => {
    const { requests } = stubLinearFetch(() => ({
      issues: { nodes: [issueNode()] },
    }));

    const out = await issuesCommand(['--fields', ''], { apiKey: FAKE_KEY });

    expect(requests[0].body.query).not.toMatch(/\n\s+url/);
    expect(out).toContain('LIN-1');
  });

  it('documents --fields in --help with the valid names', () => {
    expect(ISSUES_HELP).toContain('--fields <a,b,c>');
    expect(ISSUES_HELP).toContain('url, estimate, dueDate, createdAt');
    expect(ISSUES_HELP).toContain('linear-axi issues --fields url,estimate');
  });
});

describe('issue view --fields', () => {
  it('adds the requested key to the detail document and the output', async () => {
    const { requests } = stubLinearFetch(() => ({
      issue: detailNode({ dueDate: '2026-09-01' }),
    }));

    const out = await issueCommand(['view', 'LIN-1', '--fields', 'dueDate'], {
      apiKey: FAKE_KEY,
    });

    const query = requests[0].body.query;
    expect(query).toContain('query Issue(');
    expect(query).toMatch(/\n\s+dueDate/);
    expect(requests[0].body.variables).toEqual({ id: 'LIN-1' });
    expect(out).toContain('LIN-1');
    expect(out).toContain('2026-09-01');
    expect(out).toContain('dueDate');
  });

  it('adds multiple fields as extra detail rows (estimate,branchName)', async () => {
    const { requests } = stubLinearFetch(() => ({
      issue: detailNode({ estimate: 2, branchName: 'lin-1-ship-the-thing' }),
    }));

    const out = await issueCommand(
      ['view', 'LIN-1', '--fields', 'estimate,branchName'],
      { apiKey: FAKE_KEY },
    );

    const query = requests[0].body.query;
    expect(query).toMatch(/\n\s+estimate/);
    expect(query).toMatch(/\n\s+branchName/);
    expect(out).toContain('estimate');
    expect(out).toContain('lin-1-ship-the-thing');
  });

  it('leaves the default detail document untouched when the flag is absent', async () => {
    const { requests } = stubLinearFetch(() => ({
      issue: detailNode(),
    }));

    const out = await issueCommand(['view', 'LIN-1'], { apiKey: FAKE_KEY });

    const query = requests[0].body.query;
    expect(query).toContain('query Issue(');
    expect(query).not.toMatch(/\n\s+dueDate/);
    expect(query).not.toMatch(/\n\s+estimate/);
    expect(query).not.toMatch(/\n\s+archivedAt/);
    expect(query).not.toMatch(/\n\s+branchName/);
    expect(out).toContain('LIN-1');
    expect(out).not.toContain('dueDate');
  });

  it('rejects unknown field names loudly with the view field set', async () => {
    const { requests } = stubLinearFetch(() => ({}));

    const err = await issueCommand(['view', 'LIN-1', '--fields', 'bogus'], {
      apiKey: FAKE_KEY,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe('VALIDATION_ERROR');
    expect((err as AxiError).message).toContain('Unknown field(s): bogus');
    // The view set differs from the list set: archivedAt/branchName yes, url no.
    expect((err as AxiError).message).toContain('archivedAt');
    expect((err as AxiError).message).toContain('branchName');
    expect((err as AxiError).message).not.toContain('url, estimate');
    expect(requests).toHaveLength(0);
  });

  it('documents --fields in --help with the valid names', () => {
    expect(ISSUE_HELP).toContain('--fields <a,b,c>');
    expect(ISSUE_HELP).toContain('dueDate, estimate, archivedAt, branchName');
    expect(ISSUE_HELP).toContain(
      'issue view LIN-123 --fields dueDate,estimate',
    );
  });
});
