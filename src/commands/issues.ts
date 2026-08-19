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

export const ISSUES_HELP = `usage: linear-axi issues [--team <KEY>] [--state <type>] [--assignee <name|me>] [--label <name>] [--project <name>] [--search <text>] [--limit <n>]
	List Linear issues, most recently updated first (relevance-ranked when --search is given).

flags:
  --team <KEY>       filter by team key (e.g. LIN)
  --state <type>     workflow state type: backlog, unstarted, started, completed, canceled, triage
  --assignee <name>  "me" for yourself, or a user name
  --label <name>     filter by label name; repeat to match ANY of the given labels (issues carrying at least one)
  --project <name>   filter by project name (exact match; run \`linear-axi projects\` for names)
  --search <text>    full-text search (same ranking as Linear's app search); composable with the filters above
  --limit <n>        max issues to return (default 25, max 500; fetched in pages of 50)

examples:
  linear-axi issues
  linear-axi issues --assignee me --state started
  linear-axi issues --team LIN --label bug
  linear-axi issues --label bug --label regression
  linear-axi issues --project "Mobile app" --state started
  linear-axi issues --search "onboarding" --team LIN --state started
`;

const KNOWN_FLAGS = [
  '--team',
  '--state',
  '--assignee',
  '--label',
  '--project',
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
  const hasProject = args.some((a) => a === '--project' || a.startsWith('--project='));
  const project = takeFlag(args, '--project');
  if (hasProject && (project === undefined || project.trim() === '')) {
    // Same guard as --search: a missing value must fail loud, not drop the filter.
    throw new AxiError('--project requires a value', 'VALIDATION_ERROR', [
      'e.g. --project "Mobile app"',
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

  // Every repeated --label is applied: Linear matches issues carrying at
  // least one of the names ("any of" semantics, documented in --help).
  if (labels.length) filter.labels = labels;
  if (project) filter.project = project;
  if (search !== undefined) filter.search = search;

  const { issues, hasMore } = await fetchIssues(apiKey, filter, limit);

  const blocks: string[] = [];
  blocks.push(formatCountLine({ count: issues.length, limit, hasMore }));

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
  if (labels.length > 1 && issues.length === 0) {
    hints.push(
      `No issues carry any of: ${labels.join(', ')} — try fewer labels`,
    );
  }
  if (search !== undefined && issues.length === 0) {
    hints.push(`No matches for "${search}" — try a shorter term or drop a filter`);
  }
  if (project !== undefined && issues.length === 0) {
    hints.push(
      `No issues in project "${project}" — check the exact name with \`linear-axi projects\``,
    );
  }
  blocks.push(renderHelp(hints));

  return renderOutput(blocks);
}

/** Hard ceiling for --limit. Issues are auto-paginated in 50-size batches up to this. */
const MAX_LIMIT = 500;

function parseLimit(raw: string): number {
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1) {
    throw new AxiError(`Invalid --limit: ${raw}`, 'VALIDATION_ERROR');
  }
  // Loud failure over silent clamping (AXI principle 6): a caller asking for
  // 501 should learn the real ceiling, not get 500 back unawares.
  if (n > MAX_LIMIT) {
    throw new AxiError(
      `Invalid --limit: ${raw} (max ${MAX_LIMIT})`,
      'VALIDATION_ERROR',
      ['Results are fetched in pages of 50; the total is capped for token safety.'],
    );
  }
  return n;
}
