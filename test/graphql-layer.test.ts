// Transport-level tests for src/linear.ts (#29): call the GraphQL operation
// functions DIRECTLY against a stubbed global fetch and assert the exact
// document, variables, and resolver wiring — no command layer involved.
//
// This file is the GAP-FILL from the coverage audit, not a re-run of what the
// command-level suites already assert (all citations in the PR body):
// - fetchViewer / fetchTeams / deleteIssue documents had zero direct or
//   transitive assertions (fetchTeams and deleteIssue had none at all).
// - resolveStateIdByName (query TeamStates) was never exercised.
// - createIssue's labelNames->labelIds branch (and resolveLabelIds through
//   it), its team-not-found error, and ALL mutation success:false branches
//   were untested.
// - updateIssue's omit-null builder was only asserted in partial
//   combinations; here the minimal (title-only) and maximal
//   (title+stateName+assigneeId+labelIds) forms pin what is omitted.
// - fetchIssues' anti-spin pagination guards (missing / non-advancing cursor,
//   empty page) were untested (fetchLabels' empty-page guard is covered in
//   labels.test.ts).
//
// Fetch-stub pattern per test/comment-update-delete.test.ts and
// test/rate-limit-retry.test.ts: vi.stubGlobal('fetch', ...) serving
// Response-like { ok, status, headers, json } objects, capturing each request
// body, with afterEach(vi.unstubAllGlobals). No network access.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchViewer,
  fetchTeams,
  fetchIssue,
  fetchIssues,
  createIssue,
  updateIssue,
  deleteIssue,
  createComment,
  updateComment,
  deleteComment,
} from '../src/linear.js';
import { AxiError } from '../src/errors.js';
import type { LinearIssue } from '../src/linear.js';

const FAKE_KEY = 'lin_api_fake';

function graphqlOk(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ data }),
  } as Response;
}

interface CapturedRequest {
  url: string;
  body: { query: string; variables: Record<string, unknown> };
}

/**
 * Stub global fetch as a Linear GraphQL endpoint that routes each captured
 * document through `route` and wraps its return value in a 200/data envelope.
 * An unexpected document (route returning undefined) fails the stub.
 */
function stubLinearFetch(route: (body: CapturedRequest['body']) => unknown): {
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest['body'];
    requests.push({ url: String(url), body });
    const data = route(body);
    if (data === undefined) {
      throw new Error(`Unexpected GraphQL document in stub: ${body.query}`);
    }
    return graphqlOk(data);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests };
}

/** A detail-shaped issue node with a team id, as `query Issue(` returns it. */
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
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Serve the standard resolver chain the write paths use: TeamByKey for team
 * resolution, Labels for label resolution, Issue for ref pre-fetches, and
 * TeamStates for stateName resolution — each overridable per test.
 */
function stubResolvers(options: {
  teams?: Array<{ id: string; key: string }>;
  states?: Array<{ id: string; name: string; type: string }>;
  labels?: Array<{ id: string; name: string; color: string }>;
  issue?: LinearIssue | null;
  issueCreate?: { success: boolean };
  issueUpdate?: { success: boolean };
}): { requests: CapturedRequest[] } {
  return stubLinearFetch((body) => {
    if (body.query.includes('query TeamByKey(')) {
      return {
        teams: { nodes: options.teams ?? [{ id: 'team-1', key: 'LIN' }] },
      };
    }
    if (body.query.includes('query Labels(')) {
      return {
        issueLabels: {
          nodes: options.labels ?? [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    }
    if (body.query.includes('query Issue(')) {
      return {
        issue: options.issue === undefined ? issueNode() : options.issue,
      };
    }
    if (body.query.includes('query TeamStates(')) {
      return {
        team: {
          states: {
            nodes: options.states ?? [
              { id: 'st-todo', name: 'Todo', type: 'unstarted' },
              { id: 'st-prog', name: 'In Progress', type: 'started' },
              { id: 'st-done', name: 'Done', type: 'completed' },
            ],
          },
        },
      };
    }
    if (body.query.includes('mutation CreateIssue(')) {
      return {
        issueCreate: options.issueCreate ?? {
          success: true,
          issue: issueNode({ id: 'ir-9', identifier: 'LIN-9' }),
        },
      };
    }
    if (body.query.includes('mutation UpdateIssue(')) {
      return {
        issueUpdate: options.issueUpdate ?? {
          success: true,
          issue: issueNode(),
        },
      };
    }
    return undefined;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Read queries with no direct/transitive document assertions before this file
// ---------------------------------------------------------------------------

describe('fetchViewer', () => {
  it('sends the exact viewer document and unwraps data.viewer', async () => {
    const viewer = { id: 'u-1', name: 'Ada', email: 'ada@example.com' };
    const { requests } = stubLinearFetch(() => ({ viewer }));

    const result = await fetchViewer(FAKE_KEY);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.query).toBe('query { viewer { id name email } }');
    expect(requests[0]!.body.variables).toEqual({});
    expect(result).toEqual(viewer);
  });
});

describe('fetchTeams', () => {
  it('sends the exact teams document and unwraps the nodes', async () => {
    const teams = [
      { id: 'team-1', key: 'LIN', name: 'Linear' },
      { id: 'team-2', key: 'ENG', name: 'Engineering' },
    ];
    const { requests } = stubLinearFetch(() => ({ teams: { nodes: teams } }));

    const result = await fetchTeams(FAKE_KEY);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.query).toBe(
      'query Teams { teams { nodes { id key name } } }',
    );
    expect(requests[0]!.body.variables).toEqual({});
    expect(result).toEqual(teams);
  });

  it('returns an empty list for a workspace with no teams', async () => {
    stubLinearFetch(() => ({ teams: { nodes: [] } }));

    expect(await fetchTeams(FAKE_KEY)).toEqual([]);
  });
});

describe('fetchIssue (direct)', () => {
  it('sends the detail selection with the ref as $id', async () => {
    const { requests } = stubLinearFetch(() => ({ issue: issueNode() }));

    const issue = await fetchIssue(FAKE_KEY, 'CTZ-311');

    expect(requests).toHaveLength(1);
    const { query, variables } = requests[0]!.body;
    expect(query).toContain('query Issue($id: String!) { issue(id: $id)');
    // ISSUE_DETAIL_FIELDS essentials ride along in the same document.
    expect(query).toContain('labels { nodes { id name } }');
    expect(query).toContain('project { id name }');
    expect(query).toContain('cycle { id number }');
    // No children page without includeChildren (opt-in only, #26).
    expect(query).not.toContain('children');
    expect(variables).toEqual({ id: 'CTZ-311' });
    expect(issue?.id).toBe('ir-1');
  });

  it('maps a null issue to undefined', async () => {
    stubLinearFetch(() => ({ issue: null }));

    expect(await fetchIssue(FAKE_KEY, 'LIN-404')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deleteIssue — zero coverage before this file
// ---------------------------------------------------------------------------

describe('deleteIssue', () => {
  it('sends the DeleteIssue mutation with the id and resolves on success', async () => {
    const { requests } = stubLinearFetch(() => ({
      issueDelete: { success: true },
    }));

    await deleteIssue(FAKE_KEY, 'ir-1');

    expect(requests).toHaveLength(1);
    const { query, variables } = requests[0]!.body;
    expect(query).toContain('mutation DeleteIssue($id: String!)');
    expect(query).toContain('issueDelete(id: $id) { success }');
    expect(variables).toEqual({ id: 'ir-1' });
  });
});

// ---------------------------------------------------------------------------
// resolveStateIdByName (query TeamStates) — zero coverage before this file;
// reached through updateIssue's stateName path
// ---------------------------------------------------------------------------

describe('stateName resolution in updateIssue', () => {
  it('pre-fetches the issue and its team states, then sends stateId', async () => {
    const { requests } = stubResolvers({});

    await updateIssue(FAKE_KEY, 'LIN-1', { stateName: 'Done' });

    expect(requests).toHaveLength(3);
    expect(requests[0]!.body.query).toContain('query Issue(');
    expect(requests[1]!.body.query).toContain('query TeamStates($id: String!)');
    expect(requests[1]!.body.query).toContain(
      'team(id: $id) { states { nodes { id name type } } }',
    );
    // The team id from the pre-fetched issue, not the issue ref.
    expect(requests[1]!.body.variables).toEqual({ id: 'team-1' });
    const mutation = requests[2]!.body;
    expect(mutation.query).toContain('$stateId: String');
    expect(mutation.query).toContain('stateId: $stateId');
    expect(mutation.variables).toEqual({ id: 'LIN-1', stateId: 'st-done' });
  });

  it('matches state names case-insensitively', async () => {
    const { requests } = stubResolvers({});

    await updateIssue(FAKE_KEY, 'LIN-1', { stateName: 'in progress' });

    expect(requests[2]!.body.variables).toEqual({
      id: 'LIN-1',
      stateId: 'st-prog',
    });
  });

  it('lists the available states when the name matches none', async () => {
    const { requests } = stubResolvers({});

    const err = (await updateIssue(FAKE_KEY, 'LIN-1', {
      stateName: 'Bogus',
    }).catch((e: unknown) => e)) as AxiError;

    expect(err).toBeInstanceOf(AxiError);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toContain('State "Bogus" not found for this team');
    expect(err.suggestions?.join(' ')).toContain(
      'Available states: Todo, In Progress, Done',
    );
    // Only the two read documents fired — no mutation for an unmatched state.
    expect(requests).toHaveLength(2);
  });

  it('fails when the issue cannot be resolved to a team', async () => {
    stubResolvers({ issue: null });

    const err = (await updateIssue(FAKE_KEY, 'LIN-404', {
      stateName: 'Done',
    }).catch((e: unknown) => e)) as AxiError;

    expect(err).toBeInstanceOf(AxiError);
    expect(err.code).toBe('UNKNOWN');
    expect(err.message).toBe('Could not resolve team for issue');
  });
});

// ---------------------------------------------------------------------------
// createIssue omit-null builder — the labelNames branch, team-not-found, and
// the minimal document were untested (description/projectId/cycleId/parentId
// variations are covered in description-file/project-cycle-assignment/
// sub-issues tests)
// ---------------------------------------------------------------------------

describe('createIssue omit-null input builder', () => {
  it('sends only teamId and title for a minimal create', async () => {
    const { requests } = stubResolvers({});

    await createIssue(FAKE_KEY, { title: 'New bug', teamKey: 'LIN' });

    const mutation = requests[1]!.body;
    expect(mutation.query).toContain(
      'mutation CreateIssue($teamId: String!, $title: String!)',
    );
    expect(mutation.query).toContain(
      'issueCreate(input: { teamId: $teamId, title: $title })',
    );
    // Nothing else is declared or sent when unset.
    expect(mutation.query).not.toContain('description');
    expect(mutation.query).not.toContain('labelIds');
    expect(mutation.query).not.toContain('projectId');
    expect(mutation.query).not.toContain('cycleId');
    expect(mutation.query).not.toContain('parentId');
    expect(mutation.variables).toEqual({ teamId: 'team-1', title: 'New bug' });
  });

  it('resolves label names to ids via fetchLabels and sends labelIds', async () => {
    const { requests } = stubResolvers({
      labels: [
        { id: 'lb-bug', name: 'Bug', color: '#EB5757' },
        { id: 'lb-feat', name: 'Feature', color: '#4CB782' },
        { id: 'lb-chore', name: 'Chore', color: '#95A2B3' },
      ],
    });

    // Mixed case and an unknown name: case-insensitive match in server order,
    // unknowns silently skipped (resolveLabelIds semantics, #29 gap).
    await createIssue(FAKE_KEY, {
      title: 'New bug',
      teamKey: 'LIN',
      labelNames: ['BUG', 'Nope', 'feature'],
    });

    expect(requests[1]!.body.query).toContain('query Labels(');
    const mutation = requests[2]!.body;
    expect(mutation.query).toContain('$labelIds: [String!]');
    expect(mutation.query).toContain('labelIds: $labelIds');
    expect(mutation.variables).toEqual({
      teamId: 'team-1',
      title: 'New bug',
      labelIds: ['lb-bug', 'lb-feat'],
    });
  });

  it('fails loud when the team key matches no team', async () => {
    const { requests } = stubResolvers({ teams: [] });

    const err = (await createIssue(FAKE_KEY, {
      title: 'x',
      teamKey: 'NOPE',
    }).catch((e: unknown) => e)) as AxiError;

    expect(err).toBeInstanceOf(AxiError);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Team "NOPE" not found in your workspace');
    expect(err.suggestions?.join(' ')).toContain('linear-axi teams');
    // Only the team resolution fired — no mutation without a team id.
    expect(requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// updateIssue omit-null builder — minimal and maximal combinations
// (assigneeId / labelIds / labelIds:[] / projectId / cycleId / description
// variations are covered in issue-update-assignee-labels /
// project-cycle-assignment / description-file tests)
// ---------------------------------------------------------------------------

describe('updateIssue omit-null input builder', () => {
  it('sends only id and title for a title-only update', async () => {
    const { requests } = stubResolvers({});

    await updateIssue(FAKE_KEY, 'LIN-1', { title: 'Renamed' });

    expect(requests).toHaveLength(1);
    const { query, variables } = requests[0]!.body;
    expect(query).toContain(
      'mutation UpdateIssue($id: String!, $title: String)',
    );
    expect(query).toContain('issueUpdate(id: $id, input: { title: $title })');
    expect(query).not.toContain('description');
    expect(query).not.toContain('priority');
    expect(query).not.toContain('stateId');
    expect(query).not.toContain('assigneeId');
    expect(query).not.toContain('labelIds');
    expect(query).not.toContain('projectId');
    expect(query).not.toContain('cycleId');
    expect(variables).toEqual({ id: 'LIN-1', title: 'Renamed' });
  });

  it('declares every set field and omits the unset ones in a full update', async () => {
    const { requests } = stubResolvers({});

    await updateIssue(FAKE_KEY, 'LIN-1', {
      title: 'Renamed',
      stateName: 'Done',
      assigneeId: 'user-ada',
      labelIds: ['lb-bug', 'lb-feat'],
    });

    const mutation = requests[2]!.body;
    // Declaration and input order follow the builder: title, stateId,
    // assigneeId, labelIds — and nothing else.
    expect(mutation.query).toContain(
      'mutation UpdateIssue($id: String!, $title: String, ' +
        '$stateId: String, $assigneeId: String, $labelIds: [String!])',
    );
    expect(mutation.query).toContain(
      'issueUpdate(id: $id, input: { title: $title, stateId: $stateId, ' +
        'assigneeId: $assigneeId, labelIds: $labelIds })',
    );
    expect(mutation.query).not.toContain('description');
    expect(mutation.query).not.toContain('priority');
    expect(mutation.query).not.toContain('projectId');
    expect(mutation.query).not.toContain('cycleId');
    expect(mutation.variables).toEqual({
      id: 'LIN-1',
      title: 'Renamed',
      stateId: 'st-done',
      assigneeId: 'user-ada',
      labelIds: ['lb-bug', 'lb-feat'],
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation success:false payload branches — zero coverage before this file
// (every command-level suite stubs success: true only)
// ---------------------------------------------------------------------------

describe('mutation success:false payloads', () => {
  it('createIssue throws UNKNOWN when Linear reports success: false', async () => {
    stubResolvers({ issueCreate: { success: false } });

    const err = (await createIssue(FAKE_KEY, {
      title: 'x',
      teamKey: 'LIN',
    }).catch((e: unknown) => e)) as AxiError;

    expect(err).toBeInstanceOf(AxiError);
    expect(err.message).toBe('Linear rejected the issue create');
    expect(err.code).toBe('UNKNOWN');
  });

  it('updateIssue throws UNKNOWN when Linear reports success: false', async () => {
    stubResolvers({ issueUpdate: { success: false } });

    const err = (await updateIssue(FAKE_KEY, 'LIN-1', { title: 'x' }).catch(
      (e: unknown) => e,
    )) as AxiError;

    expect(err).toBeInstanceOf(AxiError);
    expect(err.message).toBe('Linear rejected the issue update');
    expect(err.code).toBe('UNKNOWN');
  });

  it('deleteIssue throws UNKNOWN when Linear reports success: false', async () => {
    stubLinearFetch(() => ({ issueDelete: { success: false } }));

    const err = (await deleteIssue(FAKE_KEY, 'ir-1').catch(
      (e: unknown) => e,
    )) as AxiError;

    expect(err).toBeInstanceOf(AxiError);
    expect(err.message).toBe('Linear rejected the issue delete');
    expect(err.code).toBe('UNKNOWN');
  });

  it('createComment throws UNKNOWN when Linear reports success: false', async () => {
    stubLinearFetch(() => ({ commentCreate: { success: false } }));

    const err = (await createComment(FAKE_KEY, 'ir-1', 'hi').catch(
      (e: unknown) => e,
    )) as AxiError;

    expect(err).toBeInstanceOf(AxiError);
    expect(err.message).toBe('Linear rejected the comment');
    expect(err.code).toBe('UNKNOWN');
  });

  it('updateComment throws UNKNOWN when Linear reports success: false', async () => {
    stubLinearFetch(() => ({ commentUpdate: { success: false } }));

    const err = (await updateComment(FAKE_KEY, 'cm-1', 'hi').catch(
      (e: unknown) => e,
    )) as AxiError;

    expect(err).toBeInstanceOf(AxiError);
    expect(err.message).toBe('Linear rejected the comment update');
    expect(err.code).toBe('UNKNOWN');
  });

  it('deleteComment throws UNKNOWN when Linear reports success: false', async () => {
    stubLinearFetch(() => ({ commentDelete: { success: false } }));

    const err = (await deleteComment(FAKE_KEY, 'cm-1').catch(
      (e: unknown) => e,
    )) as AxiError;

    expect(err).toBeInstanceOf(AxiError);
    expect(err.message).toBe('Linear rejected the comment delete');
    expect(err.code).toBe('UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// fetchIssues anti-spin pagination guards — cursor batching itself is covered
// directly in issues-pagination.test.ts (50-size batches, remaining-slot
// `first`); these pin the three guards against a misbehaving server.
// ---------------------------------------------------------------------------

describe('fetchIssues pagination guards', () => {
  function listNode(n: number): LinearIssue {
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

  it('stops without a follow-up when hasNextPage is true but endCursor is null', async () => {
    const { requests } = stubLinearFetch(() => ({
      issues: {
        nodes: [listNode(1), listNode(2)],
        pageInfo: { hasNextPage: true, endCursor: null },
      },
    }));

    const { issues, hasMore } = await fetchIssues(FAKE_KEY, {}, 100);

    expect(requests).toHaveLength(1);
    expect(issues).toHaveLength(2);
    // The server claimed more pages, so the truncation flag stays honest.
    expect(hasMore).toBe(true);
  });

  it('stops when the server repeats the same endCursor (non-advancing)', async () => {
    // Every page — with or without an `after` — answers with the SAME cursor.
    const { requests } = stubLinearFetch(() => ({
      issues: {
        nodes: [listNode(1)],
        pageInfo: { hasNextPage: true, endCursor: 'stuck' },
      },
    }));

    const { issues, hasMore } = await fetchIssues(FAKE_KEY, {}, 100);

    // Page 1 (no after) and page 2 (after: stuck) both return cursor "stuck"
    // — the guard breaks the loop instead of paging forever.
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body.variables).toEqual({ first: 50, after: 'stuck' });
    expect(issues).toHaveLength(2);
    expect(hasMore).toBe(true);
  });

  it('stops on an empty page that still claims hasNextPage', async () => {
    const { requests } = stubLinearFetch((body) =>
      body.variables['after'] === undefined
        ? {
            issues: {
              nodes: [listNode(1)],
              pageInfo: { hasNextPage: true, endCursor: 'c1' },
            },
          }
        : {
            issues: {
              nodes: [],
              pageInfo: { hasNextPage: true, endCursor: 'c2' },
            },
          },
    );

    const { issues, hasMore } = await fetchIssues(FAKE_KEY, {}, 100);

    expect(requests).toHaveLength(2);
    expect(issues).toHaveLength(1);
    expect(hasMore).toBe(true);
  });
});
