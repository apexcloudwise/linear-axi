// Tests for `comment update` / `comment delete` (#27): editing and removing
// comments by id through the `commentUpdate`/`commentDelete` mutations, plus
// `comment list` surfacing the ids that target them. Follows the network-free
// GraphQL stub pattern from comment-list.test.ts / description-file.test.ts:
// stub global fetch, then assert on the captured documents, variables, and
// rendered TOON output.
//
// Flow order under test:
// - update: pre-fetch the comment (query Comment) for the loud NOT_FOUND
//   branch and the parent issue identifier, then mutation UpdateComment.
// - delete: same pre-fetch, but a missing comment is the idempotent no-op
//   (mirrors deleteIssueCmd) — no mutation is issued for a gone comment.
// - list: the node selection and the rendered rows both carry comment ids.
// - round trip: list → update → delete against one stub, asserting each
//   issued document in sequence.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commentCommand, COMMENT_HELP } from '../src/commands/comment.js';
import { AxiError } from '../src/errors.js';
import type {
  LinearComment,
  LinearCommentRef,
  LinearIssue,
} from '../src/linear.js';

const FAKE_KEY = 'lin_api_fake';

const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(n: number): string {
  return new Date(Date.now() + n * DAY_MS).toISOString();
}

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

function commentNode(overrides: Partial<LinearComment> = {}): LinearComment {
  return {
    id: 'cm-9d2c',
    body: 'Looks good to me',
    user: { name: 'Ada' },
    externalUser: null,
    createdAt: daysFromNow(-1),
    ...overrides,
  };
}

/** A comment ref as returned by fetchComment's minimal selection. */
function commentRef(
  overrides: Partial<LinearCommentRef> = {},
): LinearCommentRef {
  return { id: 'cm-9d2c', issue: { identifier: 'LIN-1' }, ...overrides };
}

function graphqlOk(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data }) } as Response;
}

interface CapturedRequest {
  url: string;
  body: { query: string; variables: Record<string, unknown> };
}

/**
 * Stub global fetch as a Linear GraphQL endpoint serving every document the
 * #27 flows can issue. `commentRef` is served for the `comment(id:)`
 * pre-fetch (null models an already-gone comment), `thread` for the comments
 * query. Returns captured requests; an unexpected document fails the stub.
 */
function stubLinearFetch(options: {
  commentRef?: LinearCommentRef | null;
  thread?: LinearComment[];
}): { requests: CapturedRequest[] } {
  const ref =
    options.commentRef === undefined ? commentRef() : options.commentRef;
  const thread = options.thread ?? [commentNode()];
  const requests: CapturedRequest[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest['body'];
    requests.push({ url: String(url), body });
    // NOTE: 'query Comment(' cannot match 'query Comments(' — the required
    // "(" sits right after "Comment".
    if (body.query.includes('query Comment(')) {
      return graphqlOk({ comment: ref });
    }
    if (body.query.includes('query Comments(')) {
      return graphqlOk({
        comments: {
          nodes: thread,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
    }
    if (body.query.includes('query Issue(')) {
      return graphqlOk({ issue: issueNode() });
    }
    if (body.query.includes('mutation Comment(')) {
      return graphqlOk({ commentCreate: { success: true } });
    }
    if (body.query.includes('mutation UpdateComment(')) {
      return graphqlOk({ commentUpdate: { success: true } });
    }
    if (body.query.includes('mutation DeleteComment(')) {
      return graphqlOk({ commentDelete: { success: true } });
    }
    throw new Error(`Unexpected GraphQL document in stub: ${body.query}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('comment update document', () => {
  it('pre-fetches the comment, then sends commentUpdate with id and body', async () => {
    const { requests } = stubLinearFetch({});

    const out = await commentCommand(
      ['update', 'cm-9d2c', '--body', 'Edited body'],
      { apiKey: FAKE_KEY },
    );

    expect(requests).toHaveLength(2);
    expect(requests[0].body.query).toContain('query Comment(');
    expect(requests[0].body.variables).toEqual({ id: 'cm-9d2c' });
    const mutation = requests[1].body;
    expect(mutation.query).toContain('mutation UpdateComment(');
    expect(mutation.query).toContain(
      'commentUpdate(id: $id, input: { body: $body })',
    );
    expect(mutation.query).toContain('success');
    expect(mutation.variables).toEqual({ id: 'cm-9d2c', body: 'Edited body' });
    // Confirmation mentions the parent issue identifier from the pre-fetch.
    expect(out).toContain('comment: updated on LIN-1');
  });

  it('sends the file content as the body with --body-file', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'axi-comment-update-'));
    try {
      const file = join(tmpDir, 'comment.md');
      writeFileSync(file, 'Edited via file', 'utf-8');
      const { requests } = stubLinearFetch({});

      await commentCommand(['update', 'cm-9d2c', '--body-file', file], {
        apiKey: FAKE_KEY,
      });

      expect(requests[1].body.query).toContain('mutation UpdateComment(');
      expect(requests[1].body.variables).toEqual({
        id: 'cm-9d2c',
        body: 'Edited via file',
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to the comment id in the confirmation when the comment has no issue', async () => {
    // Comment.issue is nullable (non-issue comments) — the confirmation must
    // not crash or render an empty identifier.
    const { requests } = stubLinearFetch({
      commentRef: { id: 'cm-9d2c', issue: null },
    });

    const out = await commentCommand(['update', 'cm-9d2c', '--body', 'x'], {
      apiKey: FAKE_KEY,
    });

    expect(requests[1].body.query).toContain('mutation UpdateComment(');
    expect(out).toContain('comment: updated cm-9d2c');
  });
});

describe('comment update guards', () => {
  it('fails loud NOT_FOUND when the comment is gone (update is not idempotent)', async () => {
    const { requests } = stubLinearFetch({ commentRef: null });

    const err = await commentCommand(['update', 'cm-404', '--body', 'x'], {
      apiKey: FAKE_KEY,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe('NOT_FOUND');
    expect((err as AxiError).message).toContain('cm-404');
    // Only the pre-fetch fired — no mutation for a dead comment.
    expect(requests).toHaveLength(1);
  });

  it('rejects --body together with --body-file before any network request', async () => {
    const { requests } = stubLinearFetch({});

    await expect(
      commentCommand(
        ['update', 'cm-9d2c', '--body', 'inline', '--body-file', 'c.md'],
        { apiKey: FAKE_KEY },
      ),
    ).rejects.toThrow(/Pass only one of --body or --body-file/);

    expect(requests).toHaveLength(0);
  });

  it('requires a body and a comment id', async () => {
    const { requests } = stubLinearFetch({});

    await expect(
      commentCommand(['update', 'cm-9d2c'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/--body or --body-file is required/);

    await expect(
      commentCommand(['update'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/Missing comment id/);

    expect(requests).toHaveLength(0);
  });

  it('rejects unknown flags on the update path', async () => {
    await expect(
      commentCommand(['update', 'cm-9d2c', '--body', 'x', '--full'], {
        apiKey: FAKE_KEY,
      }),
    ).rejects.toThrow(/unknown flag --full/);
  });
});

describe('comment delete document', () => {
  it('pre-fetches the comment, then sends commentDelete with the id', async () => {
    const { requests } = stubLinearFetch({});

    const out = await commentCommand(['delete', 'cm-9d2c'], {
      apiKey: FAKE_KEY,
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].body.query).toContain('query Comment(');
    const mutation = requests[1].body;
    expect(mutation.query).toContain('mutation DeleteComment(');
    expect(mutation.query).toContain('commentDelete(id: $id) { success }');
    expect(mutation.variables).toEqual({ id: 'cm-9d2c' });
    expect(out).toContain('deleted: comment on LIN-1');
  });
});

describe('comment delete idempotence', () => {
  it('treats an already-gone comment as a no-op and issues no mutation', async () => {
    const { requests } = stubLinearFetch({ commentRef: null });

    const out = await commentCommand(['delete', 'cm-gone'], {
      apiKey: FAKE_KEY,
    });

    expect(out).toContain('comment: "cm-gone" not found (no-op)');
    // Only the pre-fetch fired — deleting a missing comment mutates nothing.
    expect(requests).toHaveLength(1);
    expect(requests[0].body.query).toContain('query Comment(');
  });

  it('requires a comment id and rejects flags on the delete path', async () => {
    await expect(
      commentCommand(['delete'], { apiKey: FAKE_KEY }),
    ).rejects.toThrow(/Missing comment id/);

    await expect(
      commentCommand(['delete', 'cm-9d2c', '--body', 'x'], {
        apiKey: FAKE_KEY,
      }),
    ).rejects.toThrow(/unknown flag --body/);
  });
});

describe('comment list surfaces ids (#27)', () => {
  it('selects and renders the comment id in every row', async () => {
    const { requests } = stubLinearFetch({
      thread: [
        commentNode({ id: 'cm-aaaa', body: 'first' }),
        commentNode({
          id: 'cm-bbbb',
          body: 'second',
          createdAt: daysFromNow(-2),
        }),
      ],
    });

    const out = await commentCommand(['list', 'LIN-1'], {
      apiKey: FAKE_KEY,
    });

    // Document: the node selection carries the id alongside body/author/time.
    const listQuery = requests[1].body.query;
    expect(listQuery).toContain('query Comments(');
    expect(listQuery).toMatch(/nodes \{\s*\n\s*id\s*\n\s*body/);
    // Render: id is the first column of every row, complete (no truncation —
    // it is the handle update/delete target).
    expect(out).toContain('comments[2]{id,author,body,created}');
    expect(out).toContain('cm-aaaa');
    expect(out).toContain('cm-bbbb');
  });
});

describe('comment dispatch (backward compat + reserved words)', () => {
  it('keeps a bare ref on the create path', async () => {
    const { requests } = stubLinearFetch({});

    const out = await commentCommand(['LIN-1', '--body', 'hello'], {
      apiKey: FAKE_KEY,
    });

    expect(requests[0].body.query).toContain('query Issue(');
    expect(requests[1].body.query).toContain('mutation Comment(');
    expect(out).toContain('comment: added to LIN-1');
  });

  it('does not treat a --body-file value as a subcommand', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'axi-comment-dispatch-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(tmpDir);
      writeFileSync('update', 'Edited via file', 'utf-8');
      const { requests } = stubLinearFetch({});

      const out = await commentCommand(
        ['--body-file', 'update', 'LIN-1'],
        { apiKey: FAKE_KEY },
      );

      expect(requests[0].body.query).toContain('query Issue(');
      expect(requests[1].body.query).toContain('mutation Comment(');
      expect(requests[1].body.variables).toEqual({
        issueId: 'ir-1',
        body: 'Edited via file',
      });
      expect(out).toContain('comment: added to LIN-1');
    } finally {
      process.chdir(previousCwd);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('documents the new subcommands and the reserved-words note', () => {
    expect(COMMENT_HELP).toContain('comment update <COMMENT-ID> --body');
    expect(COMMENT_HELP).toContain('comment delete <COMMENT-ID>');
    expect(COMMENT_HELP).toContain('idempotent: a missing comment is a no-op');
    expect(COMMENT_HELP).toContain('reserved words');
    expect(COMMENT_HELP).toContain('linear-axi comment delete 3ba4c5d6-...');
  });
});

describe('round trip: list → update → delete', () => {
  it('issues each expected document in sequence against one stub', async () => {
    const target = commentNode({ id: 'cm-9d2c', body: 'Stale body' });
    const { requests } = stubLinearFetch({ thread: [target] });
    const ctx = { apiKey: FAKE_KEY };

    // 1. list — resolve the issue, read the thread, see the id.
    const listed = await commentCommand(['list', 'LIN-1'], ctx);
    expect(listed).toContain('cm-9d2c');
    expect(requests[0].body.query).toContain('query Issue(');
    expect(requests[1].body.query).toContain('query Comments(');

    // 2. update — pre-fetch the comment by id, mutate its body.
    const updated = await commentCommand(
      ['update', 'cm-9d2c', '--body', 'Fresh body'],
      ctx,
    );
    expect(requests[2].body.query).toContain('query Comment(');
    expect(requests[3].body.query).toContain('mutation UpdateComment(');
    expect(requests[3].body.variables).toEqual({
      id: 'cm-9d2c',
      body: 'Fresh body',
    });
    expect(updated).toContain('comment: updated on LIN-1');

    // 3. delete — pre-fetch again, then remove it.
    const deleted = await commentCommand(['delete', 'cm-9d2c'], ctx);
    expect(requests[4].body.query).toContain('query Comment(');
    expect(requests[5].body.query).toContain('mutation DeleteComment(');
    expect(requests[5].body.variables).toEqual({ id: 'cm-9d2c' });
    expect(deleted).toContain('deleted: comment on LIN-1');

    // Exactly the six expected round trips — nothing else fired.
    expect(requests).toHaveLength(6);
  });
});
