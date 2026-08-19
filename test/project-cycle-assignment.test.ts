// Tests for `issue create/update --project / --cycle` (#25). Follows the
// network-free GraphQL stub pattern from issue-update-assignee-labels.test.ts:
// stub global fetch, then assert on the captured query documents, mutation
// variables, and rendered TOON output.
//
// Flow order under test:
// - create: resolve --project (query ProjectByName) and/or --cycle (query
//   TeamActiveCycles / CycleByNumber) BEFORE the mutation, then createIssue
//   resolves the team (query TeamByKey) and mutates.
// - update: resolve the ref (query Issue, now selecting project/cycle for
//   no-op detection), resolve ids, mutate.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { issueCommand, ISSUE_HELP } from '../src/commands/issue.js';
import type { LinearIssue } from '../src/linear.js';

const FAKE_KEY = 'lin_api_fake';

interface CapturedRequest {
  url: string;
  body: { query: string; variables: Record<string, unknown> };
}

/** A stub active-cycle node as returned by the cycles connection. */
interface StubCycle {
  id: string;
  number: number;
  teamKey: string;
}

interface StubOptions {
  /** The issue served for `query Issue(` (default: LIN-1, no project/cycle). */
  issue?: LinearIssue | null;
  /** Projects served for `query ProjectByName(` (default: one "Q3 launch"). */
  projects?: Array<{ id: string; name: string }>;
  /** Cycles served for the active-cycle queries (default: LIN cycle 12). */
  activeCycles?: StubCycle[];
  /** Cycles served for `query CycleByNumber(` (default: cycle 3, id cyc-3). */
  numberedCycles?: Array<{ id: string }>;
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
    project: null,
    cycle: null,
    url: 'https://linear.app/lini/issue/LIN-1/ship-the-thing',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

const DEFAULT_PROJECTS = [{ id: 'proj-q3', name: 'Q3 launch' }];

const DEFAULT_ACTIVE_CYCLES: StubCycle[] = [
  { id: 'cyc-active-lin', number: 12, teamKey: 'LIN' },
];

const DEFAULT_NUMBERED_CYCLES = [{ id: 'cyc-3' }];

function graphqlOk(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data }) } as Response;
}

function cycleNode(c: StubCycle): {
  id: string;
  number: number;
  team: { key: string };
} {
  return { id: c.id, number: c.number, team: { key: c.teamKey } };
}

/**
 * Stub global fetch as a Linear GraphQL endpoint serving every document the
 * create/update flows can issue for #25. Returns captured requests for
 * assertions. Any unexpected document fails the stub loudly.
 */
function stubFetch(opts: StubOptions = {}): { requests: CapturedRequest[] } {
  const issue = opts.issue === undefined ? issueNode() : opts.issue;
  const projects = opts.projects ?? DEFAULT_PROJECTS;
  const activeCycles = opts.activeCycles ?? DEFAULT_ACTIVE_CYCLES;
  const numberedCycles = opts.numberedCycles ?? DEFAULT_NUMBERED_CYCLES;

  const requests: CapturedRequest[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest['body'];
    requests.push({ url: String(url), body });
    if (body.query.includes('query Issue(')) {
      return graphqlOk({ issue });
    }
    if (body.query.includes('query ProjectByName(')) {
      return graphqlOk({ projects: { nodes: projects } });
    }
    if (body.query.includes('query TeamActiveCycles(')) {
      return graphqlOk({
        cycles: { nodes: activeCycles.map(cycleNode) },
      });
    }
    // The workspace-wide document has no variables, so no parens after the name.
    if (body.query.includes('query ActiveCycles')) {
      return graphqlOk({
        cycles: { nodes: activeCycles.map(cycleNode) },
      });
    }
    if (body.query.includes('query CycleByNumber(')) {
      return graphqlOk({ cycles: { nodes: numberedCycles } });
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
            title: 'Ship v2',
            url: 'https://linear.app/lini/issue/LIN-9/ship-v2',
          },
        },
      });
    }
    if (body.query.includes('mutation UpdateIssue(')) {
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
    }
    throw new Error(`Unexpected GraphQL document in stub: ${body.query}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests };
}

const createRequests = (requests: CapturedRequest[]) =>
  requests.filter((r) => r.body.query.includes('mutation CreateIssue('));
const updateRequests = (requests: CapturedRequest[]) =>
  requests.filter((r) => r.body.query.includes('mutation UpdateIssue('));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('issue create --project / --cycle', () => {
  it('resolves --project by exact name and sends projectId', async () => {
    const { requests } = stubFetch();

    const out = await issueCommand(
      [
        'create',
        '--title',
        'Ship v2',
        '--team',
        'LIN',
        '--project',
        'Q3 launch',
      ],
      { apiKey: FAKE_KEY },
    );

    // Project resolution first, then team resolution, then the mutation.
    expect(requests).toHaveLength(3);
    expect(requests[0].body.query).toContain(
      'projects(filter: { name: { eq: $name } })',
    );
    expect(requests[0].body.variables).toEqual({ name: 'Q3 launch' });
    const mutation = requests[2];
    expect(mutation.body.query).toContain('projectId: $projectId');
    expect(mutation.body.query).toContain('$projectId: String');
    expect(mutation.body.variables).toEqual({
      teamId: 'team-1',
      title: 'Ship v2',
      projectId: 'proj-q3',
    });
    expect(out).toContain('created: LIN-9');
  });

  it("resolves --cycle current to the team's active cycle and sends cycleId", async () => {
    const { requests } = stubFetch();

    await issueCommand(
      ['create', '--title', 'Ship v2', '--team', 'LIN', '--cycle', 'current'],
      { apiKey: FAKE_KEY },
    );

    expect(requests).toHaveLength(3);
    // --team scopes the active-cycle lookup on create.
    expect(requests[0].body.query).toContain('query TeamActiveCycles(');
    expect(requests[0].body.query).toContain(
      'isActive: { eq: true }, team: { key: { eq: $teamKey } }',
    );
    expect(requests[0].body.variables).toEqual({ teamKey: 'LIN' });
    const mutation = requests[2];
    expect(mutation.body.query).toContain('cycleId: $cycleId');
    expect(mutation.body.variables).toEqual({
      teamId: 'team-1',
      title: 'Ship v2',
      cycleId: 'cyc-active-lin',
    });
  });

  it('resolves a numbered --cycle against --team and sends cycleId', async () => {
    const { requests } = stubFetch();

    await issueCommand(
      ['create', '--title', 'Ship v2', '--team', 'LIN', '--cycle', '3'],
      { apiKey: FAKE_KEY },
    );

    expect(requests).toHaveLength(3);
    expect(requests[0].body.query).toContain(
      'number: { eq: $number }, team: { key: { eq: $teamKey } }',
    );
    expect(requests[0].body.variables).toEqual({ number: 3, teamKey: 'LIN' });
    expect(requests[2].body.variables).toEqual({
      teamId: 'team-1',
      title: 'Ship v2',
      cycleId: 'cyc-3',
    });
  });

  it('sends projectId AND cycleId together when both flags are given', async () => {
    const { requests } = stubFetch();

    await issueCommand(
      [
        'create',
        '--title',
        'Ship v2',
        '--team',
        'LIN',
        '--project',
        'Q3 launch',
        '--cycle',
        'current',
      ],
      { apiKey: FAKE_KEY },
    );

    const mutation = createRequests(requests)[0]!;
    expect(mutation.body.query).toContain('projectId: $projectId');
    expect(mutation.body.query).toContain('cycleId: $cycleId');
    expect(mutation.body.variables).toEqual({
      teamId: 'team-1',
      title: 'Ship v2',
      projectId: 'proj-q3',
      cycleId: 'cyc-active-lin',
    });
  });

  it('fails loud on an unknown project name (no mutation)', async () => {
    const { requests } = stubFetch({ projects: [] });

    await expect(
      issueCommand(
        ['create', '--title', 'Ship v2', '--team', 'LIN', '--project', 'Nope'],
        { apiKey: FAKE_KEY },
      ),
    ).rejects.toThrow(/Project "Nope" not found/);

    expect(createRequests(requests)).toHaveLength(0);
  });

  it('fails loud when the team has no active cycle (no mutation)', async () => {
    const { requests } = stubFetch({ activeCycles: [] });

    await expect(
      issueCommand(
        ['create', '--title', 'Ship v2', '--team', 'LIN', '--cycle', 'current'],
        { apiKey: FAKE_KEY },
      ),
    ).rejects.toThrow(/Team LIN has no active cycle/);

    expect(createRequests(requests)).toHaveLength(0);
  });

  it('requires --team (cycle numbers restart per team) — create always does', async () => {
    const { requests } = stubFetch();

    await expect(
      issueCommand(['create', '--title', 'Ship v2', '--cycle', '3'], {
        apiKey: FAKE_KEY,
      }),
    ).rejects.toThrow(/--team is required/);

    expect(requests).toHaveLength(0);
  });
});

describe('issue update --project', () => {
  it('sends projectId when the issue is in a different project', async () => {
    const { requests } = stubFetch({
      issue: issueNode({
        project: { id: 'proj-old', name: 'Old thing' },
      }),
    });

    const out = await issueCommand(
      ['update', 'LIN-1', '--project', 'Q3 launch'],
      { apiKey: FAKE_KEY },
    );

    // Ref resolution now selects the issue's current project/cycle ids.
    expect(requests[0].body.query).toContain('project { id name }');
    expect(requests[0].body.query).toContain('cycle { id number }');
    expect(requests[1].body.variables).toEqual({ name: 'Q3 launch' });
    const mutation = updateRequests(requests)[0]!;
    expect(mutation.body.query).toContain('projectId: $projectId');
    // Omit-null builder: only the changed field is declared/sent.
    expect(mutation.body.query).toContain(
      'mutation UpdateIssue($id: String!, $projectId: String)',
    );
    expect(mutation.body.variables).toEqual({
      id: 'ir-1',
      projectId: 'proj-q3',
    });
    expect(out).toContain('updated: LIN-1');
  });

  it('reports re-requesting the current project as a no-op (no mutation)', async () => {
    const { requests } = stubFetch({
      issue: issueNode({ project: { id: 'proj-q3', name: 'Q3 launch' } }),
    });

    const out = await issueCommand(
      ['update', 'LIN-1', '--project', 'Q3 launch'],
      { apiKey: FAKE_KEY },
    );

    expect(out).toContain('(no-op)');
    expect(updateRequests(requests)).toHaveLength(0);
  });

  it('sends projectId when the issue carries no project yet', async () => {
    const { requests } = stubFetch({ issue: issueNode() });

    await issueCommand(['update', 'LIN-1', '--project', 'Q3 launch'], {
      apiKey: FAKE_KEY,
    });

    expect(updateRequests(requests)[0]!.body.variables).toEqual({
      id: 'ir-1',
      projectId: 'proj-q3',
    });
  });

  it('fails loud on an unknown project name (no mutation)', async () => {
    const { requests } = stubFetch({ projects: [] });

    await expect(
      issueCommand(['update', 'LIN-1', '--project', 'Nope'], {
        apiKey: FAKE_KEY,
      }),
    ).rejects.toThrow(/Project "Nope" not found/);

    expect(updateRequests(requests)).toHaveLength(0);
  });
});

describe('issue update --cycle', () => {
  it("resolves --cycle current to the workspace's single active cycle", async () => {
    const { requests } = stubFetch({ issue: issueNode() });

    const out = await issueCommand(['update', 'LIN-1', '--cycle', 'current'], {
      apiKey: FAKE_KEY,
    });

    // Ref resolution, workspace-wide active-cycle lookup, mutate.
    expect(requests).toHaveLength(3);
    // No variables in the workspace-wide document, hence no parens after the name.
    expect(requests[1].body.query).toContain('query ActiveCycles {');
    expect(requests[1].body.query).toContain('isActive: { eq: true }');
    expect(requests[1].body.variables).toEqual({});
    const mutation = updateRequests(requests)[0]!;
    expect(mutation.body.query).toContain(
      'mutation UpdateIssue($id: String!, $cycleId: String)',
    );
    expect(mutation.body.variables).toEqual({
      id: 'ir-1',
      cycleId: 'cyc-active-lin',
    });
    expect(out).toContain('updated: LIN-1');
  });

  it('fails loud listing candidates when several teams have active cycles', async () => {
    const { requests } = stubFetch({
      activeCycles: [
        { id: 'cyc-lin-12', number: 12, teamKey: 'LIN' },
        { id: 'cyc-eng-7', number: 7, teamKey: 'ENG' },
      ],
    });

    const err = await issueCommand(['update', 'LIN-1', '--cycle', 'current'], {
      apiKey: FAKE_KEY,
    }).catch((e: { message: string; suggestions?: string[] }) => e);

    expect(err.message).toMatch(/2 active cycles/);
    expect(err.suggestions?.join(' ')).toContain('cycle 12 (LIN)');
    expect(err.suggestions?.join(' ')).toContain('cycle 7 (ENG)');
    expect(updateRequests(requests)).toHaveLength(0);
  });

  it('rejects the only active cycle when it belongs to another team', async () => {
    const { requests } = stubFetch({
      activeCycles: [{ id: 'cyc-eng-7', number: 7, teamKey: 'ENG' }],
    });

    await expect(
      issueCommand(['update', 'LIN-1', '--cycle', 'current'], {
        apiKey: FAKE_KEY,
      }),
    ).rejects.toThrow(/belongs to team LIN/);

    expect(updateRequests(requests)).toHaveLength(0);
  });

  it('scopes --cycle current to --team when given', async () => {
    const { requests } = stubFetch();

    await issueCommand(
      ['update', 'LIN-1', '--cycle', 'current', '--team', 'LIN'],
      { apiKey: FAKE_KEY },
    );

    expect(requests[1].body.query).toContain('query TeamActiveCycles(');
    expect(requests[1].body.variables).toEqual({ teamKey: 'LIN' });
    expect(updateRequests(requests)[0]!.body.variables).toEqual({
      id: 'ir-1',
      cycleId: 'cyc-active-lin',
    });
  });

  it("rejects a --team that does not match the issue's own team", async () => {
    const { requests } = stubFetch();

    await expect(
      issueCommand(['update', 'LIN-1', '--cycle', 'current', '--team', 'ENG'], {
        apiKey: FAKE_KEY,
      }),
    ).rejects.toThrow(/belongs to team LIN/);

    expect(updateRequests(requests)).toHaveLength(0);
  });

  it('resolves a numbered --cycle against --team and sends cycleId', async () => {
    const { requests } = stubFetch({
      issue: issueNode({ cycle: { id: 'cyc-active-lin', number: 12 } }),
    });

    await issueCommand(['update', 'LIN-1', '--cycle', '3', '--team', 'LIN'], {
      apiKey: FAKE_KEY,
    });

    expect(requests[1].body.query).toContain('query CycleByNumber(');
    expect(requests[1].body.variables).toEqual({ number: 3, teamKey: 'LIN' });
    expect(updateRequests(requests)[0]!.body.variables).toEqual({
      id: 'ir-1',
      cycleId: 'cyc-3',
    });
  });

  it('requires --team for a numbered cycle, before any network request', async () => {
    const { requests } = stubFetch();

    await expect(
      issueCommand(['update', 'LIN-1', '--cycle', '3'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/--cycle <number> requires --team/);

    expect(requests).toHaveLength(0);
  });

  it('fails loud when the team has no such cycle number', async () => {
    const { requests } = stubFetch({ numberedCycles: [] });

    await expect(
      issueCommand(['update', 'LIN-1', '--cycle', '9', '--team', 'LIN'], {
        apiKey: FAKE_KEY,
      }),
    ).rejects.toThrow(/Cycle 9 not found for team LIN/);

    expect(updateRequests(requests)).toHaveLength(0);
  });

  it('reports re-requesting the current cycle as a no-op (no mutation)', async () => {
    const { requests } = stubFetch({
      issue: issueNode({ cycle: { id: 'cyc-active-lin', number: 12 } }),
    });

    const out = await issueCommand(['update', 'LIN-1', '--cycle', 'current'], {
      apiKey: FAKE_KEY,
    });

    expect(out).toContain('(no-op)');
    expect(updateRequests(requests)).toHaveLength(0);
  });
});

describe('parity and guards (create and update)', () => {
  it('rejects --team on update without --cycle', async () => {
    const { requests } = stubFetch();

    await expect(
      issueCommand(['update', 'LIN-1', '--title', 'x', '--team', 'LIN'], {
        apiKey: FAKE_KEY,
      }),
    ).rejects.toThrow(/--team on update only applies to --cycle/);

    expect(requests).toHaveLength(0);
  });

  it('rejects blank --project / --cycle values loudly', async () => {
    stubFetch();
    await expect(
      issueCommand(['update', 'LIN-1', '--project', ''], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/--project requires a value/);
    await expect(
      issueCommand(['update', 'LIN-1', '--cycle', ''], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/--cycle requires a value/);
    await expect(
      issueCommand(
        ['create', '--title', 'x', '--team', 'LIN', '--project', ''],
        { apiKey: FAKE_KEY },
      ),
    ).rejects.toThrow(/--project requires a value/);
    await expect(
      issueCommand(
        ['create', '--title', 'x', '--team', 'LIN', '--cycle', 'soon'],
        { apiKey: FAKE_KEY },
      ),
    ).rejects.toThrow(/Invalid --cycle: soon/);
  });

  it('lists the new flags in the nothing-to-update guard', async () => {
    stubFetch();
    await expect(
      issueCommand(['update', 'LIN-1'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/Nothing to update.*--project, --cycle/);
  });

  it('documents the flags and examples in help (both subcommands)', () => {
    expect(ISSUE_HELP).toContain(
      'create --title "..." --team <KEY> [--description "..."] [--label <name>...] [--project <name>] [--cycle <current|number>]',
    );
    expect(ISSUE_HELP).toContain(
      '[--assignee <name|me>] [--label <name>] [--remove-label <name>] [--project <name>] [--cycle <current|number>]',
    );
    expect(ISSUE_HELP).toContain(
      'linear-axi issue create --title "Ship v2" --team LIN --project "Q3 launch" --cycle current',
    );
    expect(ISSUE_HELP).toContain(
      'linear-axi issue update LIN-123 --cycle current',
    );
    expect(ISSUE_HELP).toContain(
      'linear-axi issue update LIN-123 --cycle 3 --team LIN',
    );
  });
});
