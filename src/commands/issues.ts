import type { LinearContext } from '../context.js';
import { requireKey } from '../config.js';
import { fetchIssues, type IssueListFilter } from '../linear.js';
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

export const ISSUES_HELP = `usage: linear-axi issues [--team <KEY>] [--state <type>] [--assignee <name|me>] [--label <name>] [--limit <n>]
List Linear issues, most recently updated first.

flags:
  --team <KEY>       filter by team key (e.g. LIN)
  --state <type>     workflow state type: backlog, unstarted, started, completed, canceled, triage
  --assignee <name>  "me" for yourself, or a user name
  --label <name>     filter by label name (repeatable)
  --limit <n>        max issues to return (default 25, capped at 50)

examples:
  linear-axi issues
  linear-axi issues --assignee me --state started
  linear-axi issues --team LIN --label bug
`;

const KNOWN_FLAGS = [
  '--team',
  '--state',
  '--assignee',
  '--label',
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
      filter.assigneeIsMe = true;
    } else {
      filter.assigneeName = assignee;
    }
  }

  // `issues` supports a single label filter in the API; combine names with OR
  // by issuing one query per label would be heavier — for v1 use the first
  // label only and surface a hint when more were passed.
  if (labels.length) filter.label = labels[0];

  const { issues, totalCount } = await fetchIssues(apiKey, filter, limit);

  const blocks: string[] = [];
  blocks.push(formatCountLine({ count: issues.length, limit, totalCount }));

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
