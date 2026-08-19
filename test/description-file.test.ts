// Tests for `--description-file` (#28): read the issue description from a
// UTF-8 file — or "-" for stdin to EOF — on `issue create` and `issue
// update`. Follows the network-free GraphQL stub pattern from
// project-cycle-assignment.test.ts / sub-issues.test.ts: stub global fetch,
// then assert on the captured mutation variables and rendered TOON output.
//
// Flow order under test:
// - create --description-file: the file is read BEFORE any network request,
//   then team resolution (query TeamByKey) and the CreateIssue mutation
//   carry the file content as `description`.
// - update --description-file: same pre-network read, then the Issue fetch
//   and the UpdateIssue mutation carry the content.
// - "-" (stdin): reader-level fd-0 semantics via the injectable `read`
//   function, plus command-level runs where node:fs serves fixed content
//   for fd 0.
// - Guards: mutual exclusion with --description, blank flag values,
//   unreadable paths, and empty input all fail loud with zero network
//   traffic (a silently-empty description would wipe the field on update).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  issueCommand,
  ISSUE_HELP,
  readDescriptionFile,
} from '../src/commands/issue.js';
import { AxiError } from '../src/errors.js';
import type { LinearIssue } from '../src/linear.js';

const FAKE_KEY = 'lin_api_fake';

// node:fs is mocked file-wide with a readFileSync spy that delegates to the
// real implementation by default (so tmp fixtures and any import-time reads
// keep working); the stdin tests override the next call only. The factory
// spread keeps every other export real.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

// Loose mock handle: node's readFileSync overloads make the precise
// MockInstance type unwieldy, and these tests only need "serve fixed
// content on the next call".
const readFileMock = vi.mocked(readFileSync) as unknown as MockInstance<
  (...args: unknown[]) => unknown
>;

/** Multi-line body with the shell-quoting hazards the flag exists to avoid. */
const DESCRIPTION = `## Steps to reproduce

1. Run the command with a "quoted" arg
2. Observe the **failure**

It's got 'apostrophes', $hell expansions, and
line breaks — no shell can mangle it through a file.`;

const STDIN_BODY = 'piped straight through stdin\nwith newlines\n';

interface CapturedRequest {
  url: string;
  body: { query: string; variables: Record<string, unknown> };
}

function issueNode(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'ir-7',
    identifier: 'LIN-7',
    title: 'Wire the toggle',
    description: 'Old body',
    state: { name: 'Todo', type: 'unstarted' },
    priority: 0,
    assignee: null,
    team: { key: 'LIN', name: 'Linear', id: 'team-1' },
    labels: { nodes: [] },
    project: null,
    cycle: null,
    url: 'https://linear.app/lini/issue/LIN-7/wire-the-toggle',
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
 * #28 flows can issue. Returns captured requests for assertions; any
 * unexpected document fails the stub loudly.
 */
function stubFetch(): { requests: CapturedRequest[] } {
  const issue = issueNode();
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
    if (body.query.includes('mutation UpdateIssue(')) {
      return graphqlOk({
        issueUpdate: {
          success: true,
          issue: {
            id: 'ir-7',
            identifier: 'LIN-7',
            title: 'Wire the toggle',
            url: 'https://linear.app/lini/issue/LIN-7/wire-the-toggle',
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

let tmpDir: string;

function writeTmp(name: string, content: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

/** Assert the thunk throws a VALIDATION_ERROR matching message. */
function expectLoud(fn: () => unknown, message: RegExp): void {
  try {
    fn();
  } catch (err) {
    const axi = err as AxiError;
    expect(axi.message).toMatch(message);
    expect(axi.code).toBe('VALIDATION_ERROR');
    return;
  }
  throw new Error(`expected a loud VALIDATION_ERROR matching ${message}`);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'axi-description-file-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  // mockReset restores the real-implementation default from vi.fn(impl).
  readFileMock.mockReset();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('readDescriptionFile reader semantics', () => {
  it('reads a path through the underlying read function', () => {
    const seen: Array<string | number> = [];
    const content = readDescriptionFile('issue.md', (source) => {
      seen.push(source);
      return 'file body';
    });
    expect(content).toBe('file body');
    expect(seen).toEqual(['issue.md']);
  });

  it('maps "-" to fd 0 — stdin, read to EOF', () => {
    const seen: Array<string | number> = [];
    const content = readDescriptionFile('-', (source) => {
      seen.push(source);
      return STDIN_BODY;
    });
    expect(content).toBe(STDIN_BODY);
    expect(seen).toEqual([0]);
  });

  it('fails loud when the file read throws', () => {
    expectLoud(
      () =>
        readDescriptionFile('missing.md', () => {
          throw new Error('ENOENT');
        }),
      /Could not read --description-file: missing\.md/,
    );
  });

  it('fails loud when the stdin read throws', () => {
    expectLoud(
      () =>
        readDescriptionFile('-', () => {
          throw new Error('EAGAIN');
        }),
      /Could not read --description-file: -/,
    );
  });

  it('fails loud on empty and whitespace-only content', () => {
    for (const empty of ['', '   \n\t\n']) {
      expectLoud(
        () => readDescriptionFile('issue.md', () => empty),
        /--description-file is empty: issue\.md/,
      );
    }
  });
});

describe('issue create --description-file', () => {
  it('sends the file content as the description variable', async () => {
    const file = writeTmp('issue.md', DESCRIPTION);
    const { requests } = stubFetch();

    const out = await issueCommand(
      [
        'create',
        '--title',
        'Wire the toggle',
        '--team',
        'LIN',
        '--description-file',
        file,
      ],
      { apiKey: FAKE_KEY },
    );

    expect(requests[0]!.body.query).toContain('query TeamByKey(');
    const mutation = createRequests(requests)[0]!;
    expect(mutation.body.query).toContain('description: $description');
    expect(mutation.body.variables).toEqual({
      teamId: 'team-1',
      title: 'Wire the toggle',
      description: DESCRIPTION,
    });
    expect(out).toContain('created: LIN-9');
  });

  it('reads stdin for "-" end to end', async () => {
    // The only readFileSync call on this path is the reader's fd-0 read.
    readFileMock.mockImplementationOnce(() => STDIN_BODY);
    const { requests } = stubFetch();

    await issueCommand(
      [
        'create',
        '--title',
        'From pipe',
        '--team',
        'LIN',
        '--description-file',
        '-',
      ],
      { apiKey: FAKE_KEY },
    );

    expect(createRequests(requests)[0]!.body.variables).toEqual({
      teamId: 'team-1',
      title: 'From pipe',
      description: STDIN_BODY,
    });
  });

  it('rejects --description together with --description-file before any network request', async () => {
    const { requests } = stubFetch();

    await expect(
      issueCommand(
        [
          'create',
          '--title',
          't',
          '--team',
          'LIN',
          '--description',
          'inline',
          '--description-file',
          'issue.md',
        ],
        { apiKey: FAKE_KEY },
      ),
    ).rejects.toThrow(/Pass only one of --description or --description-file/);

    expect(requests).toHaveLength(0);
  });

  it('rejects an unreadable path before any network request', async () => {
    const { requests } = stubFetch();

    await expect(
      issueCommand(
        [
          'create',
          '--title',
          't',
          '--team',
          'LIN',
          '--description-file',
          join(tmpDir, 'nope.md'),
        ],
        { apiKey: FAKE_KEY },
      ),
    ).rejects.toThrow(/Could not read --description-file: .*nope\.md/);

    expect(requests).toHaveLength(0);
  });

  it('rejects an empty file before any network request', async () => {
    const file = writeTmp('empty.md', '\n  \n');
    const { requests } = stubFetch();

    await expect(
      issueCommand(
        ['create', '--title', 't', '--team', 'LIN', '--description-file', file],
        { apiKey: FAKE_KEY },
      ),
    ).rejects.toThrow(/--description-file is empty/);

    expect(requests).toHaveLength(0);
  });

  it('rejects a blank flag value', async () => {
    await expect(
      issueCommand(
        ['create', '--title', 't', '--team', 'LIN', '--description-file', ''],
        { apiKey: FAKE_KEY },
      ),
    ).rejects.toThrow(/--description-file requires a value/);
  });

  it('sends no description without the flags (default unchanged)', async () => {
    const { requests } = stubFetch();

    await issueCommand(['create', '--title', 'Ship v2', '--team', 'LIN'], {
      apiKey: FAKE_KEY,
    });

    const mutation = createRequests(requests)[0]!;
    expect(mutation.body.query).not.toContain('description');
    expect(mutation.body.variables).toEqual({
      teamId: 'team-1',
      title: 'Ship v2',
    });
  });
});

describe('issue update --description-file', () => {
  it('sends the file content as the description variable', async () => {
    const file = writeTmp('issue.md', DESCRIPTION);
    const { requests } = stubFetch();

    const out = await issueCommand(
      ['update', 'LIN-7', '--description-file', file],
      {
        apiKey: FAKE_KEY,
      },
    );

    expect(requests[0]!.body.query).toContain('query Issue(');
    const mutation = updateRequests(requests)[0]!;
    expect(mutation.body.query).toContain('description: $description');
    expect(mutation.body.variables).toEqual({
      id: 'ir-7',
      description: DESCRIPTION,
    });
    expect(out).toContain('updated: LIN-7');
  });

  it('reads stdin for "-" end to end', async () => {
    readFileMock.mockImplementationOnce(() => STDIN_BODY);
    const { requests } = stubFetch();

    await issueCommand(['update', 'LIN-7', '--description-file', '-'], {
      apiKey: FAKE_KEY,
    });

    expect(updateRequests(requests)[0]!.body.variables).toEqual({
      id: 'ir-7',
      description: STDIN_BODY,
    });
  });

  it('rejects --description together with --description-file before any network request', async () => {
    const { requests } = stubFetch();

    await expect(
      issueCommand(
        [
          'update',
          'LIN-7',
          '--description',
          'inline',
          '--description-file',
          'issue.md',
        ],
        { apiKey: FAKE_KEY },
      ),
    ).rejects.toThrow(/Pass only one of --description or --description-file/);

    expect(requests).toHaveLength(0);
  });

  it('rejects an unreadable path before any network request', async () => {
    const { requests } = stubFetch();

    await expect(
      issueCommand(
        ['update', 'LIN-7', '--description-file', join(tmpDir, 'nope.md')],
        { apiKey: FAKE_KEY },
      ),
    ).rejects.toThrow(/Could not read --description-file: .*nope\.md/);

    expect(requests).toHaveLength(0);
  });
});

describe('help documents --description-file (#28)', () => {
  it('lists the flag on both write subcommands plus the stdin form', () => {
    expect(ISSUE_HELP).toContain(
      'create --title "..." --team <KEY> [--description "..."] [--description-file <path>]',
    );
    expect(ISSUE_HELP).toContain(
      '[--priority <0-4>] [--description "..."] [--description-file <path>]',
    );
    expect(ISSUE_HELP).toContain('pass "-" to read stdin to EOF');
    expect(ISSUE_HELP).toContain(
      'linear-axi issue create --title "Fix login" --team ENG --description-file ./issue.md',
    );
    expect(ISSUE_HELP).toContain(
      'cat notes.md | linear-axi issue update LIN-123 --description-file -',
    );
  });
});
