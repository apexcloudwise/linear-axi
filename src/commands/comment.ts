import type { LinearContext } from '../context.js';
import { requireKey } from '../config.js';
import { fetchIssue, createComment } from '../linear.js';
import { assertKnownFlags, takeFlag, getPositional } from '../args.js';
import { AxiError } from '../errors.js';
import { renderHelp, renderOutput } from '../toon.js';
import { readFileSync } from 'node:fs';

export const COMMENT_HELP = `usage: linear-axi comment <IDENTIFIER|UUID> --body "..." [--body-file <path>]
Add a comment to a Linear issue.

flags:
  --body "text"        comment body (inline)
  --body-file <path>   read body from a UTF-8 file (use for multi-line)

examples:
  linear-axi comment LIN-123 --body "Looks good to me"
  linear-axi comment LIN-123 --body-file ./notes.md
`;

const KNOWN_FLAGS = ['--body', '--body-file'];

export async function commentCommand(
  args: string[],
  ctx: LinearContext,
): Promise<string> {
  assertKnownFlags(args, KNOWN_FLAGS);
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
