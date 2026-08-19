import type { LinearContext } from '../context.js';
import { requireKey } from '../config.js';
import {
  fetchIssue,
  createIssue,
  updateIssue,
  deleteIssue,
} from '../linear.js';
import {
  assertKnownFlags,
  takeFlag,
  takeAllFlags,
  takeBoolFlag,
  getPositional,
} from '../args.js';
import { AxiError } from '../errors.js';
import { parseFields, type ExtraFieldSpec } from '../fields.js';
import {
  field,
  custom,
  pluck,
  joinArray,
  relativeTime,
  renderDetail,
  renderHelp,
  renderOutput,
  truncateForDisplay,
  type FieldDef,
} from '../toon.js';

export const ISSUE_HELP = `usage: linear-axi issue <subcommand> [args]
Manage Linear issues.

subcommands:
  view <IDENTIFIER|UUID>   show issue details (--full disables description truncation; --fields <a,b,c> adds extra fields)
  create --title "..." --team <KEY> [--description "..."] [--label <name>...]
  update <ref> [--state <name>] [--title "..."] [--priority <0-4>] [--description "..."]
  delete <ref>

view --fields names (opt-in, comma-separated): dueDate, estimate, archivedAt, branchName
  default detail fields are untouched without the flag

examples:
  linear-axi issue view LIN-123
  linear-axi issue view LIN-123 --full
  linear-axi issue view LIN-123 --fields dueDate,estimate
  linear-axi issue create --title "Fix login" --team ENG --label bug
  linear-axi issue update LIN-123 --state "In Progress"
  linear-axi issue delete LIN-123
`;

const VIEW_FLAGS = ['--full', '--fields'];
const CREATE_FLAGS = ['--title', '--team', '--description', '--label'];
const UPDATE_FLAGS = ['--state', '--title', '--priority', '--description'];

const detailSchema: FieldDef[] = [
  field('identifier'),
  field('title'),
  custom('state', (item) => item.state?.name ?? ''),
  custom('state_type', (item) => item.state?.type ?? ''),
  field('priority'),
  pluck('assignee', 'name', 'assignee'),
  pluck('team', 'key', 'team'),
  joinArray('labels', 'name', 'labels'),
  field('url'),
  relativeTime('createdAt', 'created'),
  relativeTime('updatedAt', 'updated'),
];

/**
 * Opt-in extra fields for `issue view --fields` (#23). Only fields NOT already
 * in the default detail output are offered; each linearKey is a scalar on
 * Linear's Issue type (verified against the generated types in @linear/sdk
 * v90.0.0): dueDate (TimelessDate serialized YYYY-MM-DD, null when unset),
 * estimate (Float, null when unset), archivedAt (DateTime, null when not
 * archived), branchName (String).
 */
const VIEW_EXTRA_FIELDS: Record<string, ExtraFieldSpec> = {
  dueDate: { linearKey: 'dueDate', def: field('dueDate') },
  estimate: { linearKey: 'estimate', def: field('estimate') },
  archivedAt: { linearKey: 'archivedAt', def: relativeTime('archivedAt', 'archived') },
  branchName: { linearKey: 'branchName', def: field('branchName') },
};

export async function issueCommand(
  args: string[],
  ctx: LinearContext,
): Promise<string> {
  const sub = getPositional(args, 0);
  if (!sub) {
    throw new AxiError('Missing issue subcommand', 'VALIDATION_ERROR', [
      'Run `linear-axi issue view <IDENTIFIER>`',
      'Run `linear-axi issue create --title "..." --team <KEY>`',
      'Run `linear-axi issue --help` for all subcommands',
    ]);
  }

  switch (sub) {
    case 'view':
      return viewIssue(args.slice(1), ctx);
    case 'create':
      return createIssueCmd(args.slice(1), ctx);
    case 'update':
      return updateIssueCmd(args.slice(1), ctx);
    case 'delete':
      return deleteIssueCmd(args.slice(1), ctx);
    default:
      throw new AxiError(`Unknown issue subcommand: ${sub}`, 'VALIDATION_ERROR', [
        'Subcommands: view, create, update, delete',
      ]);
  }
}

async function viewIssue(
  args: string[],
  ctx: LinearContext,
): Promise<string> {
  assertKnownFlags(args, VIEW_FLAGS);
  const apiKey = requireKey(ctx.apiKey);
  const full = takeBoolFlag(args, '--full');
  // Opt-in extra fields (--fields): unknown names fail loud (parseFields)
  // before any network request; a blank value selects nothing.
  const { extraDefs, extraLinearKeys } = parseFields(
    takeFlag(args, '--fields'),
    VIEW_EXTRA_FIELDS,
  );
  const refRaw = getPositional(args);
  if (!refRaw) {
    throw new AxiError('Missing issue reference', 'VALIDATION_ERROR', [
      'Run `linear-axi issue view <IDENTIFIER>` (e.g. LIN-123)',
    ]);
  }

  const issue = await fetchIssue(apiKey, refRaw, extraLinearKeys);
  if (!issue) {
    throw new AxiError(
      `Issue "${refRaw}" not found`,
      'NOT_FOUND',
      ['Run `linear-axi issues` to list issues'],
    );
  }

  const blocks: string[] = [
    renderDetail('issue', issue, [...detailSchema, ...extraDefs]),
  ];

  // Description: truncated by default, full on --full (principle 3).
  const { preview, total, truncated } = truncateForDisplay(
    issue.description,
    full ? Infinity : 1000,
  );
  if (preview || total) {
    blocks.push(
      full
        ? `description:\n${preview}`
        : truncated
          ? `description:\n${preview}\n  ... (truncated, ${total} chars total)\nhelp[1]:\n  Run \`linear-axi issue view ${issue.identifier} --full\` for the full description`
          : `description:\n${preview}`,
    );
  }

  blocks.push(
    renderHelp([
      `Run \`linear-axi issue update ${issue.identifier} --state "<name>"\` to change state`,
      `Run \`linear-axi comment ${issue.identifier} --body "..." to comment`,
    ]),
  );

  return renderOutput(blocks);
}

async function createIssueCmd(
  args: string[],
  ctx: LinearContext,
): Promise<string> {
  assertKnownFlags(args, CREATE_FLAGS);
  const apiKey = requireKey(ctx.apiKey);

  const title = takeFlag(args, '--title');
  const team = takeFlag(args, '--team');
  const description = takeFlag(args, '--description');
  const labels = takeAllFlags(args, '--label');

  if (!title || !title.trim()) {
    throw new AxiError('--title is required', 'VALIDATION_ERROR', [
      'linear-axi issue create --title "..." --team <KEY>',
    ]);
  }
  if (!team || !team.trim()) {
    throw new AxiError('--team is required', 'VALIDATION_ERROR', [
      'linear-axi issue create --team <KEY> (run `linear-axi teams` for keys)',
    ]);
  }

  const issue = await createIssue(apiKey, {
    title: title.trim(),
    description,
    teamKey: team.trim(),
    labelNames: labels,
  });

  const blocks: string[] = [
    renderDetail(
      'issue',
      issue,
      detailSchema.filter(
        (d) => 'key' in d && ['identifier', 'title'].includes(d.key),
      ),
    ),
    `created: ${issue.identifier} (${issue.url ?? ''})`.trim(),
  ];
  blocks.push(
    renderHelp([
      `Run \`linear-axi issue view ${issue.identifier}\` for details`,
      `Run \`linear-axi issue update ${issue.identifier} --state "<name>"\` to set state`,
    ]),
  );
  return renderOutput(blocks);
}

async function updateIssueCmd(
  args: string[],
  ctx: LinearContext,
): Promise<string> {
  assertKnownFlags(args, UPDATE_FLAGS);
  const apiKey = requireKey(ctx.apiKey);

  const refRaw = getPositional(args);
  if (!refRaw) {
    throw new AxiError('Missing issue reference', 'VALIDATION_ERROR', [
      'Run `linear-axi issue update <IDENTIFIER> --state "<name>"`',
    ]);
  }

  const stateName = takeFlag(args, '--state');
  const title = takeFlag(args, '--title');
  const priorityRaw = takeFlag(args, '--priority');
  const description = takeFlag(args, '--description');

  if (!stateName && !title && priorityRaw === undefined && description === undefined) {
    throw new AxiError(
      'Nothing to update — pass at least one of --state, --title, --priority, --description',
      'VALIDATION_ERROR',
    );
  }

  let priority: number | undefined;
  if (priorityRaw !== undefined) {
    priority = parsePriority(priorityRaw);
  }

  const existing = await fetchIssue(apiKey, refRaw);
  if (!existing) {
    throw new AxiError(`Issue "${refRaw}" not found`, 'NOT_FOUND');
  }

  // Idempotency: if a requested state already matches, treat as no-op.
  if (
    stateName &&
    existing.state?.name?.toLowerCase() === stateName.toLowerCase()
  ) {
    return renderOutput([
      `issue: ${existing.identifier} already "${stateName}" (no-op)`,
    ]);
  }

  const updated = await updateIssue(apiKey, existing.id, {
    title,
    description,
    stateName,
    priority,
  });

  return renderOutput([
    renderDetail(
      'issue',
      updated,
      detailSchema.filter(
        (d) => 'key' in d && ['identifier', 'title'].includes(d.key),
      ),
    ),
    `updated: ${updated.identifier}`,
    renderHelp([
      `Run \`linear-axi issue view ${updated.identifier}\` to confirm`,
    ]),
  ]);
}

async function deleteIssueCmd(
  args: string[],
  ctx: LinearContext,
): Promise<string> {
  const apiKey = requireKey(ctx.apiKey);
  const refRaw = getPositional(args);
  if (!refRaw) {
    throw new AxiError('Missing issue reference', 'VALIDATION_ERROR', [
      'Run `linear-axi issue delete <IDENTIFIER>`',
    ]);
  }

  const existing = await fetchIssue(apiKey, refRaw);
  if (!existing) {
    // Idempotent: already gone.
    return renderOutput([`issue: "${refRaw}" not found (no-op)`]);
  }

  await deleteIssue(apiKey, existing.id);
  return renderOutput([
    `deleted: ${existing.identifier} "${existing.title}"`,
  ]);
}

function parsePriority(raw: string): number {
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 0 || n > 4) {
    throw new AxiError(
      `Invalid --priority: ${raw} (use 0-4)`,
      'VALIDATION_ERROR',
    );
  }
  return n;
}
