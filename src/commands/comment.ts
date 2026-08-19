import type { LinearContext } from '../context.js';
import { requireKey } from '../config.js';
import {
  fetchIssue,
  createComment,
  fetchComments,
  fetchComment,
  updateComment,
  deleteComment,
} from '../linear.js';
import {
  assertKnownFlags,
  takeFlag,
  takeBoolFlag,
  getPositional,
} from '../args.js';
import { AxiError } from '../errors.js';
import {
  custom,
  field,
  relativeTime,
  renderHelp,
  renderList,
  renderOutput,
  truncateForDisplay,
  type FieldDef,
} from '../toon.js';
import { formatCountLine } from '../format.js';
import { readFileSync } from 'node:fs';

/**
 * Body preview length for `comment list` rows. Shorter than issue view's
 * 1000-char description preview because a list renders one row per comment
 * (author + body + time); a 200-char preview keeps a long thread scannable
 * while still showing real content. `--full` disables truncation entirely
 * (AXI principle 3: preview + total size, never silent omission).
 */
const COMMENT_BODY_PREVIEW = 200;

export const COMMENT_HELP = `usage: linear-axi comment <IDENTIFIER|UUID> --body "..." [--body-file <path>]
       linear-axi comment list <IDENTIFIER|UUID> [--full]
       linear-axi comment update <COMMENT-ID> --body "..." [--body-file <path>]
       linear-axi comment delete <COMMENT-ID>
	Add, read, edit, or remove comments on a Linear issue.

subcommands:
  list <IDENTIFIER|UUID>   read the issue's comment thread, newest first (--full disables body truncation)
  update <COMMENT-ID>      edit a comment's body (get ids from \`comment list\`)
  delete <COMMENT-ID>      remove a comment (idempotent: a missing comment is a no-op)

  "list", "update", and "delete" are reserved words: a bare reference that
  matches one of them cannot route to the create path (no real ref can).

flags:
  --body "text"        comment body (inline; create and update)
  --body-file <path>   read body from a UTF-8 file (use for multi-line; create and update)
  --full               list: show full comment bodies instead of ${COMMENT_BODY_PREVIEW}-char previews

examples:
  linear-axi comment LIN-123 --body "Looks good to me"
  linear-axi comment LIN-123 --body-file ./notes.md
  linear-axi comment list LIN-123
  linear-axi comment list LIN-123 --full
  linear-axi comment update 3ba4c5d6-... --body "Edited: see the notes"
  linear-axi comment delete 3ba4c5d6-...
`;

const CREATE_FLAGS = ['--body', '--body-file'];
const LIST_FLAGS = ['--full'];
const UPDATE_FLAGS = ['--body', '--body-file'];
const DELETE_FLAGS: string[] = [];

export async function commentCommand(
  args: string[],
  ctx: LinearContext,
): Promise<string> {
  // Backward compatible dispatch: a bare `comment <ref> --body "..."` (no
  // subcommand) keeps working — the create path stays the default. Only a
  // literal first positional from the reserved set selects a subcommand, and
  // no Linear issue reference (TEAM-NUMBER like LIN-123, or a UUID) can
  // collide with those words, so existing invocations are unaffected.
  const sub = getPositional(args, 0);
  if (sub === 'list') {
    return listComments(args.slice(1), ctx);
  }
  if (sub === 'update') {
    return updateCommentCmd(args.slice(1), ctx);
  }
  if (sub === 'delete') {
    return deleteCommentCmd(args.slice(1), ctx);
  }
  return createCommentCmd(args, ctx);
}

async function listComments(
  args: string[],
  ctx: LinearContext,
): Promise<string> {
  assertKnownFlags(args, LIST_FLAGS);
  const apiKey = requireKey(ctx.apiKey);
  const full = takeBoolFlag(args, '--full');

  const refRaw = getPositional(args);
  if (!refRaw) {
    throw new AxiError('Missing issue reference', 'VALIDATION_ERROR', [
      'Run `linear-axi comment list <IDENTIFIER>` (e.g. LIN-123)',
    ]);
  }

  // Resolve the ref first: the issue's id scopes the comments filter, its
  // identifier seeds the hints, and an unknown ref fails loud here.
  const issue = await fetchIssue(apiKey, refRaw);
  if (!issue) {
    throw new AxiError(`Issue "${refRaw}" not found`, 'NOT_FOUND', [
      'Run `linear-axi issues` to list issues',
    ]);
  }

  const { comments, hasMore } = await fetchComments(apiKey, issue.id);

  const blocks: string[] = [];
  blocks.push(formatCountLine({ count: comments.length, hasMore }));

  if (comments.length) {
    blocks.push(renderList('comments', comments, listSchema(full)));
  } else {
    blocks.push('comments: 0 found');
  }

  const hints: string[] = [];
  const anyTruncated = comments.some(
    (c) => c.body.length > COMMENT_BODY_PREVIEW,
  );
  if (anyTruncated && !full) {
    hints.push(
      `Run \`linear-axi comment list ${issue.identifier} --full\` for untruncated bodies`,
    );
  }
  hints.push(
    `Run \`linear-axi comment ${issue.identifier} --body "..."\` to ${comments.length ? 'reply' : 'start the thread'}`,
  );
  if (comments.length) {
    hints.push(
      'Run `linear-axi comment update <id> --body "..."` to edit, or `comment delete <id>` to remove',
    );
  }
  blocks.push(renderHelp(hints));

  return renderOutput(blocks);
}

/**
 * Field order: id, author, body, created. The id is the comment's UUID —
 * rendered in full (never truncated) because it is the handle `comment
 * update`/`comment delete` target (#27); a truncated id could not be
 * copy-pasted back into a command. It is also short in practice relative to
 * the body preview beside it.
 */
function listSchema(full: boolean): FieldDef[] {
  return [
    field('id'),
    custom('author', (item: any) => authorName(item)),
    custom('body', (item: any) => commentBodyForDisplay(item.body, full)),
    relativeTime('createdAt', 'created'),
  ];
}

/**
 * Author display name. Workspace comments carry `user`; comments created
 * through integrations (Slack, Intercom) carry `externalUser` instead
 * (Comment.user is nullable per @linear/sdk). Neither present (bots without
 * a user association) renders as "unknown".
 */
function authorName(item: {
  user?: { name: string } | null;
  externalUser?: { displayName: string } | null;
}): string {
  return item.user?.name ?? item.externalUser?.displayName ?? 'unknown';
}

function commentBodyForDisplay(
  body: string | null | undefined,
  full: boolean,
): string {
  const { preview, total, truncated } = truncateForDisplay(
    body,
    full ? Infinity : COMMENT_BODY_PREVIEW,
  );
  return truncated ? `${preview} (${total} chars total)` : preview;
}

async function createCommentCmd(
  args: string[],
  ctx: LinearContext,
): Promise<string> {
  assertKnownFlags(args, CREATE_FLAGS);
  const apiKey = requireKey(ctx.apiKey);

  const refRaw = getPositional(args);
  if (!refRaw) {
    throw new AxiError('Missing issue reference', 'VALIDATION_ERROR', [
      'Run `linear-axi comment <IDENTIFIER> --body "..."`',
    ]);
  }

  const body = takeFlag(args, '--body');
  const bodyFile = takeFlag(args, '--body-file');
  if (!body && !bodyFile) {
    throw new AxiError('--body or --body-file is required', 'VALIDATION_ERROR', [
      'linear-axi comment <IDENTIFIER> --body "..."',
      'linear-axi comment <IDENTIFIER> --body-file <path>',
    ]);
  }
  if (body && bodyFile) {
    throw new AxiError(
      'Pass only one of --body or --body-file',
      'VALIDATION_ERROR',
    );
  }

  const text = body ?? readBodyFile(bodyFile!);

  const issue = await fetchIssue(apiKey, refRaw);
  if (!issue) {
    throw new AxiError(`Issue "${refRaw}" not found`, 'NOT_FOUND');
  }

  await createComment(apiKey, issue.id, text);

  return renderOutput([
    `comment: added to ${issue.identifier}`,
    renderHelp([
      `Run \`linear-axi issue view ${issue.identifier}\` to see it in context`,
      `Run \`linear-axi comment list ${issue.identifier}\` to read the thread`,
    ]),
  ]);
}

/**
 * `comment update <COMMENT-ID> --body|--body-file` (#27). The body guards
 * mirror the create path exactly (mutual exclusion + readBodyFile) so both
 * write paths behave identically.
 *
 * Pre-fetches the comment (mirrors updateIssueCmd): update is NOT
 * idempotent-by-convention — only delete is — so a missing comment fails
 * LOUD with NOT_FOUND rather than silently no-oping. The pre-fetch also
 * carries the parent issue's identifier (Comment.issue, nullable in the
 * schema for non-issue comments), which the confirmation mentions when
 * available.
 */
async function updateCommentCmd(
  args: string[],
  ctx: LinearContext,
): Promise<string> {
  assertKnownFlags(args, UPDATE_FLAGS);
  const apiKey = requireKey(ctx.apiKey);

  const idRaw = getPositional(args);
  if (!idRaw) {
    throw new AxiError('Missing comment id', 'VALIDATION_ERROR', [
      'Run `linear-axi comment update <COMMENT-ID> --body "..."` (ids come from `comment list`)',
    ]);
  }

  const body = takeFlag(args, '--body');
  const bodyFile = takeFlag(args, '--body-file');
  if (!body && !bodyFile) {
    throw new AxiError('--body or --body-file is required', 'VALIDATION_ERROR', [
      'linear-axi comment update <COMMENT-ID> --body "..."',
      'linear-axi comment update <COMMENT-ID> --body-file <path>',
    ]);
  }
  if (body && bodyFile) {
    throw new AxiError(
      'Pass only one of --body or --body-file',
      'VALIDATION_ERROR',
    );
  }

  const text = body ?? readBodyFile(bodyFile!);

  const comment = await fetchComment(apiKey, idRaw);
  if (!comment) {
    throw new AxiError(`Comment "${idRaw}" not found`, 'NOT_FOUND', [
      'Run `linear-axi comment list <IDENTIFIER>` to see comment ids',
    ]);
  }

  await updateComment(apiKey, comment.id, text);

  // Confirmation mentions the issue identifier when the pre-fetch carried
  // one (the usual case); a non-issue comment (Comment.issue is nullable)
  // falls back to the comment id so the line stays unambiguous.
  const identifier = comment.issue?.identifier;
  return renderOutput([
    `comment: updated${identifier ? ` on ${identifier}` : ` ${comment.id}`}`,
    renderHelp([
      ...(identifier
        ? [
            `Run \`linear-axi comment list ${identifier}\` to read the thread`,
          ]
        : []),
      `Run \`linear-axi comment delete ${comment.id}\` to remove it`,
    ]),
  ]);
}

/**
 * `comment delete <COMMENT-ID>` (#27). Idempotent no-op when the comment is
 * already gone — mirroring deleteIssueCmd's pre-fetch pattern (chosen over
 * mapping Linear's delete-not-found error so the convention lives in one
 * place in the command layer). Like issue delete, ANY missing id no-ops:
 * delete is safe to re-run after a prior delete or with a stale id.
 */
async function deleteCommentCmd(
  args: string[],
  ctx: LinearContext,
): Promise<string> {
  assertKnownFlags(args, DELETE_FLAGS);
  const apiKey = requireKey(ctx.apiKey);

  const idRaw = getPositional(args);
  if (!idRaw) {
    throw new AxiError('Missing comment id', 'VALIDATION_ERROR', [
      'Run `linear-axi comment delete <COMMENT-ID>` (ids come from `comment list`)',
    ]);
  }

  const comment = await fetchComment(apiKey, idRaw);
  if (!comment) {
    // Idempotent: already gone.
    return renderOutput([`comment: "${idRaw}" not found (no-op)`]);
  }

  await deleteComment(apiKey, comment.id);
  return renderOutput([
    `deleted: comment${comment.issue ? ` on ${comment.issue.identifier}` : ` ${comment.id}`}`,
  ]);
}

function readBodyFile(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    throw new AxiError(
      `Could not read --body-file: ${path}`,
      'VALIDATION_ERROR',
    );
  }
}
