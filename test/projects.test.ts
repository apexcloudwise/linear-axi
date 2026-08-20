// Tests for the `projects` command and `issues --project` filter (#20),
// following the network-free GraphQL stub pattern from issues-search.test.ts
// and issues-pagination.test.ts: stub global fetch, then assert on the
// captured query document, variables, and rendered TOON output.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { projectsCommand, PROJECTS_HELP } from '../src/commands/projects.js';
import { issuesCommand, ISSUES_HELP } from '../src/commands/issues.js';
import { fetchProjects, resolveProjectId } from '../src/linear.js';
import { AxiError } from '../src/errors.js';
import type { LinearIssue, LinearProject } from '../src/linear.js';

const FAKE_KEY = 'lin_api_fake';

interface CapturedRequest {
  url: string;
  body: { query: string; variables: Record<string, unknown> };
}

/** A minimal Linear project node matching PROJECT_LIST_FIELDS. */
function projectNode(overrides: Partial<LinearProject> = {}): LinearProject {
  return {
    id: 'pr-1',
    name: 'Mobile app',
    status: { type: 'started' },
    progress: 0.42,
    lead: { name: 'Ada' },
    targetDate: '2026-09-30',
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('projects command', () => {
  it('requests name, status type, progress, lead, and targetDate, and renders them', async () => {
    const { requests } = stubLinearFetch(() => ({
      projects: {
        nodes: [projectNode()],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }));

    const out = await projectsCommand([], { apiKey: FAKE_KEY });

    const query = requests[0].body.query;
    expect(requests[0].url).toBe('https://api.linear.app/graphql');
    expect(query).toContain('projects(');
    expect(query).toContain('name');
    expect(query).toContain('status { type }');
    expect(query).toContain('progress');
    expect(query).toContain('lead { name }');
    expect(query).toContain('targetDate');
    expect(query).toContain('orderBy: updatedAt');
    expect(requests[0].body.variables).toEqual({ first: 50 });
    expect(out).toContain('Mobile app');
    expect(out).toContain('started');
    expect(out).toContain('42'); // 0.42 rendered as integer percent
    expect(out).toContain('Ada');
    expect(out).toContain('2026-09-30');
    expect(out).toContain('count: 1');
  });

  it('renders none for a missing lead or target date', async () => {
    stubLinearFetch(() => ({
      projects: {
        nodes: [projectNode({ lead: null, targetDate: null })],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }));

    const out = await projectsCommand([], { apiKey: FAKE_KEY });

    expect(out).toContain('none');
  });

  it('renders a definitive empty state when the workspace has no projects', async () => {
    stubLinearFetch(() => ({
      projects: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }));

    const out = await projectsCommand([], { apiKey: FAKE_KEY });

    expect(out).toContain('projects: 0 found');
    expect(out).toContain('Create a project in the Linear app');
  });

  it('hints at issues --project when projects are listed', async () => {
    stubLinearFetch(() => ({
      projects: {
        nodes: [projectNode()],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }));

    const out = await projectsCommand([], { apiKey: FAKE_KEY });

    expect(out).toContain('issues --project');
  });

  it('auto-paginates in 50-size batches until the server is exhausted', async () => {
    const many = (start: number, count: number): LinearProject[] =>
      Array.from({ length: count }, (_, i) =>
        projectNode({ id: `pr-${start + i}`, name: `Project ${start + i}` }),
      );

    const { requests } = stubLinearFetch((req) => {
      const after = req.body.variables['after'];
      if (after === undefined)
        return {
          projects: {
            nodes: many(1, 50),
            pageInfo: { hasNextPage: true, endCursor: 'c1' },
          },
        };
      if (after === 'c1')
        return {
          projects: {
            nodes: many(51, 10),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      return {
        projects: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    });

    const { projects, hasMore } = await fetchProjects(FAKE_KEY);

    expect(requests).toHaveLength(2);
    expect(requests[0].body.variables).toEqual({ first: 50 });
    expect(requests[1].body.variables).toEqual({ first: 50, after: 'c1' });
    expect(projects).toHaveLength(60);
    expect(projects[0]!.name).toBe('Project 1');
    expect(projects[59]!.name).toBe('Project 60');
    expect(hasMore).toBe(false);
  });

  it('renders the truncation count when the project limit is reached', async () => {
    const projects = Array.from({ length: 50 }, (_, i) =>
      projectNode({ id: `pr-${i}`, name: `Project ${i}` }),
    );
    let page = 0;
    stubLinearFetch(() => {
      page += 1;
      return {
        projects: {
          nodes: projects,
          pageInfo: { hasNextPage: true, endCursor: `cursor-${page}` },
        },
      };
    });

    const out = await projectsCommand([], { apiKey: FAKE_KEY });

    expect(out).toContain('count: 100 (showing first 100)');
  });

  it('documents state values and percent progress in --help', () => {
    expect(PROJECTS_HELP).toContain(
      'backlog, planned, started, paused, completed, canceled',
    );
    expect(PROJECTS_HELP).toContain('percent complete, 0-100');
  });

  it('rejects unknown flags loudly (no flags are valid)', async () => {
    stubLinearFetch(() => ({}));

    await expect(
      projectsCommand(['--bogus'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/unknown flag --bogus/);
  });

  it('rejects positional arguments loudly', async () => {
    await expect(projectsCommand(['extra'], { apiKey: FAKE_KEY })).rejects.toThrow(
      /Unexpected argument: extra/,
    );
  });
});

describe('issues --project filter', () => {
  it('composes project with team and state into the IssueFilter', async () => {
    const { requests } = stubLinearFetch(() => ({
      issues: { nodes: [issueNode()] },
    }));

    const out = await issuesCommand(
      ['--project', 'Mobile app', '--team', 'LIN', '--state', 'started'],
      { apiKey: FAKE_KEY },
    );

    const query = requests[0].body.query;
    expect(query).toContain('issues(');
    expect(query).toContain('project: { name: { eq: "Mobile app" } }');
    expect(query).toContain('team: { key: { eq: "LIN" } }');
    expect(query).toContain('state: { type: { eq: "started" } }');
    expect(out).toContain('LIN-1');
  });

  it('composes project with --search in the searchIssues query', async () => {
    const { requests } = stubLinearFetch(() => ({
      searchIssues: { nodes: [] },
    }));

    const out = await issuesCommand(
      ['--search', 'crash', '--project', 'Mobile app'],
      { apiKey: FAKE_KEY },
    );

    const query = requests[0].body.query;
    expect(query).toContain('searchIssues(');
    expect(query).toContain('project: { name: { eq: "Mobile app" } }');
    expect(requests[0].body.variables).toEqual({ term: 'crash', first: 25 });
    // Empty search result keeps the search hint and gains no project noise.
    expect(out).toContain('issues: 0 found');
    expect(out).toContain('No matches for "crash"');
  });

  it('hints at the exact-name check when a project filter matches nothing', async () => {
    stubLinearFetch(() => ({
      issues: { nodes: [] },
    }));

    const out = await issuesCommand(['--project', 'Mobile app'], {
      apiKey: FAKE_KEY,
    });

    expect(out).toContain(
      'No issues in project "Mobile app" — check the exact name with `linear-axi projects`',
    );
  });

  it('rejects a missing or blank --project value instead of dropping it', async () => {
    stubLinearFetch(() => ({}));

    await expect(
      issuesCommand(['--project'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(AxiError);

    await expect(
      issuesCommand(['--project='], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/--project requires a value/);
    await expect(
      issuesCommand(['--project', '--limit', '25'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/--project requires a value/);
  });

  it('rejects unknown flags alongside --project', async () => {
    stubLinearFetch(() => ({}));

    await expect(
      issuesCommand(['--project', 'X', '--bogus'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/unknown flag --bogus/);
  });

  it('documents --project in --help', () => {
    expect(ISSUES_HELP).toContain('--project <name>');
    expect(ISSUES_HELP).toContain('linear-axi projects');
  });
});

describe('resolveProjectId', () => {
  it('resolves an exact project name to its id', async () => {
    const { requests } = stubLinearFetch(() => ({
      projects: { nodes: [{ id: 'pr-9', name: 'Mobile app' }] },
    }));

    const id = await resolveProjectId(FAKE_KEY, 'Mobile app');

    expect(id).toBe('pr-9');
    expect(requests[0].body.query).toContain(
      'projects(filter: { name: { eq: $name } })',
    );
    expect(requests[0].body.variables).toEqual({ name: 'Mobile app' });
  });

  it('returns undefined when no project matches', async () => {
    stubLinearFetch(() => ({
      projects: { nodes: [] },
    }));

    const id = await resolveProjectId(FAKE_KEY, 'No such project');

    expect(id).toBeUndefined();
  });
});
