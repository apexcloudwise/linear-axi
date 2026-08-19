import type { LinearContext } from '../context.js';
import { requireKey } from '../config.js';
import { fetchIssues, fetchViewer, type IssueListFilter } from '../linear.js';
import { assertKnownFlags, takeFlag, takeAllFlags } from '../args.js';
import { AxiError } from '../errors.js';
import {
  field,
  custom,
  pluck,
  relativeTime,
  renderList,
  renderHelp,
  renderOutput,
  type FieldDef,
} from '../toon.js';
import { formatCountLine } from '../format.js';

export const ISSUES_HELP = `usage: linear-axi issues [--team <KEY>] [--state <type>] [--assignee <name|me>] [--label <name>] [--search <text>] [--limit <n>]
List Linear issues, most recently updated first (relevance-ranked when --search is given).

flags:
  --team <KEY>       filter by team key (e.g. LIN)
  --state <type>     workflow state type: backlog, unstarted, started, completed, canceled, triage
  --assignee <name>  "me" for yourself, or a user name
  --label <name>     filter by label name (repeatable)
  --search <text>    full-text search (same ranking as Linear's app search); composable with the filters above
  --limit <n>        max issues to return (default 25, capped at 50)

examples:
  linear-axi issues
  linear-axi issues --assignee me --state started
  linear-axi issues --team LIN --label bug
  linear-axi issues --search "onboarding" --team LIN --state started
`;

const KNOWN_FLAGS = [
  '--team',
  '--state',
  '--assignee',
  '--label',
  '--search',
  '--limit',
];

const listSchema: FieldDef[] = [
  field('identifier'),
  field('title'),
  custom('state', (item: any) => item.state?.name?.toLowerCase() ?? ''),
  pluck('team', 'key', 'team'),
  relativeTime('updatedAt', 'updated'),
];

const STATE_TYPES = new Set([
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
  'triage',
]);

export async function issuesCommand(
  args: string[],
  ctx: LinearContext,
): Promise<string> {
  assertKnownFlags(args, KNOWN_FLAGS);
  const apiKey = requireKey(ctx.apiKey);

  const team = takeFlag(args, '--team');
  const stateType = takeFlag(args, '--state');
  const assignee = takeFlag(args, '--assignee');
  const labels = takeAllFlags(args, '--label');
  const hasSearch = args.some((a) => a === '--search' || a.startsWith('--search='));
  const search = takeFlag(args, '--search');
  if (hasSearch && (search === undefined || search.trim() === '')) {
    // takeFlag returns undefined for a missing value; never silently drop a search.
    throw new AxiError('--search requires a value', 'VALIDATION_ERROR', [
      'e.g. --search "onboarding"',
    ]);
  }
  const limitRaw = takeFlag(args, '--limit');
  const limit = limitRaw ? parseLimit(limitRaw) : 25;

  if (stateType && !STATE_TYPES.has(stateType.toLowerCase())) {
    throw new AxiError(
      `Unknown state type: "${stateType}"`,
      'VALIDATION_ERROR',
      [
        `Valid types: ${[...STATE_TYPES].join(', ')}`,
      ],
    );
  }

  if (args.some((a) => !a.startsWith('--') && a !== '')) {
    const stray = args.filter((a) => !a.startsWith('--'));
    throw new AxiError(
      `Unexpected argument: ${stray[0]}`,
      'VALIDATION_ERROR',
      ['`issues` takes only flags — run `linear-axi issues --help`'],
    );
  }

  const filter: IssueListFilter = {
    team,
    stateType: stateType?.toLowerCase(),
  };

  if (assignee) {
    if (assignee.toLowerCase() === 'me') {
      // "me" resolves to the viewer's email (Linear has no isMe comparator).
      const viewer = await fetchViewer(apiKey).catch(() => null);
      if (!viewer?.email) {
        throw new AxiError(
          'Could not resolve your Linear user for --assignee me',
          'UNKNOWN',
        );
      }
      filter.assigneeEmail = viewer.email;
    } else {
      filter.assigneeName = assignee;
    }
  }

  // The API matches "at least one label"; pass the first label only for v1.
  if (labels.length) filter.label = labels[0];
  if (search !== undefined) filter.search = search;

  const { issues } = await fetchIssues(apiKey, filter, limit);

  const blocks: string[] = [];
  blocks.push(formatCountLine({ count: issues.length, limit }));

  if (issues.length) {
    blocks.push(renderList('issues', issues, listSchema));
  } else {
    blocks.push('issues: 0 found');
  }

  const hints: string[] = [];
  if (issues.length) {
    hints.push(
      'Run `linear-axi issue view <IDENTIFIER>` for details',
    );
    hints.push('Run `linear-axi issue create --title "..." --team <KEY>` to add one');
  } else {
    hints.push(
      'Run `linear-axi issue create --title "..." --team <KEY>` to create one',
    );
  }
  if (labels.length > 1) {
    hints.push(
      `Only the first label ("${labels[0]}") was applied — multi-label filter lands post-v1`,
    );
  }
  if (search !== undefined && issues.length === 0) {
    hints.push(`No matches for "${search}" — try a shorter term or drop a filter`);
  }
  blocks.push(renderHelp(hints));

  return renderOutput(blocks);
}

function parseLimit(raw: string): number {
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1) {
    throw new AxiError(`Invalid --limit: ${raw}`, 'VALIDATION_ERROR');
  }
  return Math.min(n, 50);
}
