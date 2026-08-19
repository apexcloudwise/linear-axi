import type { LinearContext } from '../context.js';
import { requireKey } from '../config.js';
import { fetchIssue, createComment, fetchComments } from '../linear.js';
import {
  assertKnownFlags,
  takeFlag,
  takeBoolFlag,
  getPositional,
} from '../args.js';
import { AxiError } from '../errors.js';
import {
  custom,
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
Add a comment to a Linear issue, or read its comment thread.

subcommands:
  list <IDENTIFIER|UUID>   read the issue's comment thread, newest first (--full disables body truncation)

flags:
  --body "text"        comment body (inline; create)
  --body-file <path>   read body from a UTF-8 file (use for multi-line; create)
  --full               list: show full comment bodies instead of ${COMMENT_BODY_PREVIEW}-char previews

examples:
  linear-axi comment LIN-123 --body "Looks good to me"
  linear-axi comment LIN-123 --body-file ./notes.md
  linear-axi comment list LIN-123
  linear-axi comment list LIN-123 --full
`;

const CREATE_FLAGS = ['--body', '--body-file'];
const LIST_FLAGS = ['--full'];

export async function commentCommand(
  args: string[],
  ctx: LinearContext,
): Promise<string> {
  // Backward compatible dispatch: a bare `comment <ref> --body "..."` (no
  // subcommand) keeps working — the create path stays the default. Only the
  // literal first positional "list" selects the read subcommand, and no
  // Linear issue reference (TEAM-NUMBER like LIN-123, or a UUID) can collide
  // with that word, so existing invocations are unaffected.
  const sub = getPositional(args, 0);
  if (sub === 'list') {
    return listComments(args.slice(1), ctx);
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
  blocks.push(renderHelp(hints));

  return renderOutput(blocks);
}

/** Field order: author, body, created. */
function listSchema(full: boolean): FieldDef[] {
  return [
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
