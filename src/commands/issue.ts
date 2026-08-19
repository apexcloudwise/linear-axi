import type { LinearContext } from '../context.js';
import { requireKey } from '../config.js';
import type { LinearIssueChild } from '../linear.js';
import {
  fetchIssue,
  fetchViewer,
  createIssue,
  updateIssue,
  deleteIssue,
  resolveUserId,
  resolveLabelIds,
  requireProjectId,
  fetchActiveCycles,
  resolveCycleIdByNumber,
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
  view <IDENTIFIER|UUID>   show issue details (--full shows the full description and sub-issues; --fields <a,b,c> adds extra fields)
  create --title "..." --team <KEY> [--description "..."] [--label <name>...] [--project <name>] [--cycle <current|number>] [--parent <IDENTIFIER|UUID>]
  update <ref> [--state <name>] [--title "..."] [--priority <0-4>] [--description "..."]
         [--assignee <name|me>] [--label <name>] [--remove-label <name>] [--project <name>] [--cycle <current|number>]
  delete <ref>

view --fields names (opt-in, comma-separated): dueDate, estimate, archivedAt, branchName
  default detail fields are untouched without the flag

update flags:
  --assignee <name|me>     assign the issue; "me" is the authenticated viewer
  --label <name>           add a label (repeatable; names from \`linear-axi labels\`)
  --remove-label <name>    remove a label (repeatable); removing the last one clears labels

sub-issue flags:
  --parent <IDENTIFIER|UUID>   create: nest the new issue under this parent (fails loud if not found;
                               cross-team parents are allowed — the hierarchy spans teams)
  --full (view)                also lists the issue's children, one "identifier | title | state" line each

project/cycle flags (create and update):
  --project <name>         put the issue in a project (exact name; run \`linear-axi projects\`)
  --cycle <current|number> put the issue in a cycle: "current" = the active cycle — with --team, that team's;
                           without --team (update only), the workspace's single active one (fails if several teams have one);
                           a cycle number always requires --team (numbers restart per team; run \`linear-axi cycles\`)
  --team <KEY>             scopes --cycle; on create it is the issue's team, on update it must be the issue's own team

examples:
  linear-axi issue view LIN-123
  linear-axi issue view LIN-123 --full
  linear-axi issue view LIN-123 --fields dueDate,estimate
  linear-axi issue create --title "Fix login" --team ENG --label bug
  linear-axi issue create --title "Ship v2" --team LIN --project "Q3 launch" --cycle current
  linear-axi issue create --title "Wire the toggle" --team ENG --parent LIN-42
  linear-axi issue update LIN-123 --state "In Progress"
  linear-axi issue update LIN-123 --assignee me --label bug
  linear-axi issue update LIN-123 --remove-label bug
  linear-axi issue update LIN-123 --project "Mobile app"
  linear-axi issue update LIN-123 --cycle current
  linear-axi issue update LIN-123 --cycle 3 --team LIN
  linear-axi issue delete LIN-123
`;

const VIEW_FLAGS = ['--full', '--fields'];
const CREATE_FLAGS = [
  '--title',
  '--team',
  '--description',
  '--label',
  '--project',
  '--cycle',
  '--parent',
];
const UPDATE_FLAGS = [
  '--state',
  '--title',
  '--priority',
  '--description',
  '--assignee',
  '--label',
  '--remove-label',
  '--project',
  '--cycle',
  '--team',
];

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

  const issue = await fetchIssue(apiKey, refRaw, extraLinearKeys, full);
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

  // Sub-issues (#26): the children connection was selected (under --full) —
  // render it after the description. Manual block rather than renderList: one
  // `identifier | title | state` line per child is a third of the tokens of a
  // TOON array-of-objects while carrying exactly the three fields issue #26's
  // acceptance names.
  if (full) {
    blocks.push(renderSubIssues(issue.children));
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
  // has* detection must precede takeFlag (which removes the flag pair).
  const hasProject = args.some(
    (a) => a === '--project' || a.startsWith('--project='),
  );
  const projectName = takeFlag(args, '--project');
  const hasCycle = args.some(
    (a) => a === '--cycle' || a.startsWith('--cycle='),
  );
  const cycleRaw = takeFlag(args, '--cycle');
  const hasParent = args.some(
    (a) => a === '--parent' || a.startsWith('--parent='),
  );
  const parentRaw = takeFlag(args, '--parent');

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

  // Blank/missing --project/--cycle values fail loud before any network
  // request (same guard shape as the `issues` read path).
  if (hasProject && (projectName === undefined || projectName.trim() === '')) {
    throw new AxiError('--project requires a value', 'VALIDATION_ERROR', [
      'e.g. --project "Q3 launch"',
    ]);
  }
  if (hasCycle && (cycleRaw === undefined || cycleRaw.trim() === '')) {
    throw new AxiError('--cycle requires a value', 'VALIDATION_ERROR', [
      'Use --cycle current for the active cycle, or --cycle <number> (per --team)',
    ]);
  }
  if (hasParent && (parentRaw === undefined || parentRaw.trim() === '')) {
    throw new AxiError('--parent requires a value', 'VALIDATION_ERROR', [
      'e.g. --parent LIN-42 (identifier or UUID of the parent issue)',
    ]);
  }

  // Resolve --project/--cycle to ids BEFORE the mutation (#25): a loud
  // failure here beats an issue created without its requested project/cycle.
  // On create --team is required, so every cycle lookup is team-scoped — no
  // cross-team ambiguity exists on this path.
  let projectId: string | undefined;
  if (projectName) {
    projectId = await requireProjectId(apiKey, projectName.trim());
  }
  let cycleId: string | undefined;
  if (cycleRaw !== undefined) {
    const spec = parseCycleValue(cycleRaw);
    cycleId =
      spec === 'current'
        ? await requireActiveCycleId(apiKey, team.trim())
        : await requireCycleIdByNumber(apiKey, team.trim(), spec);
  }

  // Sub-issue parent (#26): resolve --parent to the parent issue's ID BEFORE
  // the mutation, the same resolve-loud-before-write convention as
  // --project/--cycle. Linear's IssueCreateInput.parentId would also accept
  // the raw identifier ("Can be a UUID or issue identifier (e.g., 'LIN-123')",
  // @linear/sdk v90), but pre-resolving turns an unknown parent into a clean
  // NOT_FOUND instead of an opaque mutation error. Cross-team parents are
  // deliberately NOT rejected client-side — Linear's sub-issue hierarchy
  // spans teams (a child may live in a different team than its parent), so
  // any genuine workspace-level rejection surfaces through the normal API
  // error mapping.
  let parentId: string | undefined;
  if (parentRaw !== undefined) {
    const parent = await fetchIssue(apiKey, parentRaw.trim());
    if (!parent) {
      throw new AxiError(
        `Parent issue "${parentRaw.trim()}" not found`,
        'NOT_FOUND',
        ['Run `linear-axi issues` to list issues'],
      );
    }
    parentId = parent.id;
  }

  const issue = await createIssue(apiKey, {
    title: title.trim(),
    description,
    teamKey: team.trim(),
    labelNames: labels,
    projectId,
    cycleId,
    parentId,
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
  const assigneeRaw = takeFlag(args, '--assignee');
  const addLabelNames = takeAllFlags(args, '--label');
  const removeLabelNames = takeAllFlags(args, '--remove-label');
  // has* detection must precede takeFlag (which removes the flag pair).
  const hasProject = args.some(
    (a) => a === '--project' || a.startsWith('--project='),
  );
  const projectRaw = takeFlag(args, '--project');
  const hasCycle = args.some(
    (a) => a === '--cycle' || a.startsWith('--cycle='),
  );
  const cycleRaw = takeFlag(args, '--cycle');
  const hasTeam = args.some(
    (a) => a === '--team' || a.startsWith('--team='),
  );
  const teamRaw = takeFlag(args, '--team');

  if (
    !stateName &&
    !title &&
    priorityRaw === undefined &&
    description === undefined &&
    assigneeRaw === undefined &&
    addLabelNames.length === 0 &&
    removeLabelNames.length === 0 &&
    projectRaw === undefined &&
    cycleRaw === undefined
  ) {
    throw new AxiError(
      'Nothing to update — pass at least one of --state, --title, --priority, --description, --assignee, --label, --remove-label, --project, --cycle',
      'VALIDATION_ERROR',
    );
  }

  // Blank/missing values fail loud before any network request (same guard
  // shape as the `issues` read path).
  if (hasProject && (projectRaw === undefined || projectRaw.trim() === '')) {
    throw new AxiError('--project requires a value', 'VALIDATION_ERROR', [
      'e.g. --project "Q3 launch"',
    ]);
  }
  if (hasCycle && (cycleRaw === undefined || cycleRaw.trim() === '')) {
    throw new AxiError('--cycle requires a value', 'VALIDATION_ERROR', [
      'Use --cycle current for the active cycle, or --cycle <number> --team <KEY>',
    ]);
  }
  const teamKey = teamRaw?.trim();
  if (hasTeam && !teamKey) {
    throw new AxiError('--team requires a value', 'VALIDATION_ERROR');
  }
  // --team on update exists ONLY to scope --cycle resolution (moving an issue
  // between teams is not supported) — reject it alone rather than silently
  // dropping it (AXI principle 6).
  if (teamKey && cycleRaw === undefined) {
    throw new AxiError(
      '--team on update only applies to --cycle resolution',
      'VALIDATION_ERROR',
      ['e.g. --cycle current --team LIN, or --cycle <number> --team <KEY>'],
    );
  }

  let priority: number | undefined;
  if (priorityRaw !== undefined) {
    priority = parsePriority(priorityRaw);
  }

  // Cycle spec parsing also happens before any network request so the
  // numeric-without-team case fails loud exactly like the #21 read path
  // (cycle numbers restart per team, so a bare number is ambiguous).
  let cycleSpec: 'current' | number | undefined;
  if (cycleRaw !== undefined) {
    cycleSpec = parseCycleValue(cycleRaw);
    if (cycleSpec !== 'current' && !teamKey) {
      throw new AxiError(
        '--cycle <number> requires --team (cycle numbers restart per team)',
        'VALIDATION_ERROR',
        [
          `e.g. --cycle ${cycleSpec} --team LIN`,
          'Or use --cycle current without --team',
        ],
      );
    }
  }

  // Blank flag values fail loud before any network request (takeAllFlags
  // already rejects blank --label/--remove-label the same way).
  const assigneeName = assigneeRaw?.trim();
  if (assigneeRaw !== undefined && !assigneeName) {
    throw new AxiError('--assignee requires a value', 'VALIDATION_ERROR');
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

  // Assignee (#24): "me" resolves to the viewer — fetchViewer already
  // returns the id the mutation needs, so no users() round trip. Any other
  // value resolves through users(filter: { name: { eq } }) and fails loud on
  // no match or an ambiguous display name. Requesting the current assignee
  // is a field-level no-op (skipped, like a matching state above).
  let assigneeId: string | undefined;
  if (assigneeName) {
    let resolvedId: string;
    let resolvedName: string;
    if (assigneeName.toLowerCase() === 'me') {
      const viewer = await fetchViewer(apiKey).catch(() => null);
      if (!viewer?.id) {
        throw new AxiError(
          'Could not resolve your Linear user for --assignee me',
          'UNKNOWN',
        );
      }
      resolvedId = viewer.id;
      resolvedName = viewer.name;
    } else {
      resolvedId = await resolveUserId(apiKey, assigneeName);
      resolvedName = assigneeName;
    }
    const currentAssignee = existing.assignee?.name;
    if (
      !currentAssignee ||
      resolvedName.toLowerCase() !== currentAssignee.toLowerCase()
    ) {
      assigneeId = resolvedId;
    }
  }

  // Labels (#24): Linear's labelIds REPLACES the whole set, so compute the
  // final set here — the issue's current label ids (ISSUE_DETAIL_FIELDS
  // selects labels { nodes { id name } }) minus names matched by
  // --remove-label (case-insensitive, against the issue's own labels so an
  // absent name is a harmless no-op), unioned with --label names resolved
  // workspace-wide via resolveLabelIds. When the computed set equals the
  // current one the field is skipped; when removal empties it, [] is sent
  // explicitly (updateIssue) — removing the last label must work.
  let labelIds: string[] | undefined;
  if (addLabelNames.length > 0 || removeLabelNames.length > 0) {
    const currentNodes = existing.labels?.nodes ?? [];
    const currentIds = currentNodes
      .map((n) => n.id)
      .filter((id): id is string => id !== undefined);
    const removeLower = removeLabelNames.map((n) => n.trim().toLowerCase());
    const keptIds = currentNodes
      .filter((n) => !removeLower.includes(n.name.toLowerCase()))
      .map((n) => n.id)
      .filter((id): id is string => id !== undefined);
    const addIds = addLabelNames.length
      ? await resolveLabelIds(apiKey, addLabelNames)
      : [];
    const nextIds = [...new Set([...keptIds, ...addIds])];
    const unchanged =
      nextIds.length === currentIds.length &&
      nextIds.every((id) => currentIds.includes(id));
    if (!unchanged) {
      labelIds = nextIds;
    }
  }

  // Project (#25): resolve loud (requireProjectId — a silently missing project
  // would surprise), then field-level no-op — requesting the project the issue
  // already carries skips the field, exactly like a matching assignee above.
  let projectId: string | undefined;
  if (projectRaw !== undefined) {
    const resolved = await requireProjectId(apiKey, projectRaw.trim());
    if (existing.project?.id !== resolved) {
      projectId = resolved;
    }
  }

  // Cycle (#25): same field-level no-op against the issue's current cycle id.
  // --team, when given, must be the issue's OWN team — resolving against
  // another team would attach the issue to a foreign team's cycle.
  let cycleId: string | undefined;
  if (cycleSpec !== undefined) {
    const issueTeamKey = existing.team?.key;
    if (
      teamKey &&
      issueTeamKey &&
      teamKey.toUpperCase() !== issueTeamKey.toUpperCase()
    ) {
      throw new AxiError(
        `Issue ${existing.identifier} belongs to team ${issueTeamKey} — --team must match it for --cycle resolution`,
        'VALIDATION_ERROR',
        [`Drop --team, or use --team ${issueTeamKey}`],
      );
    }
    const resolved =
      cycleSpec === 'current'
        ? await requireActiveCycleId(apiKey, teamKey, issueTeamKey)
        : await requireCycleIdByNumber(apiKey, teamKey!, cycleSpec);
    if (existing.cycle?.id !== resolved) {
      cycleId = resolved;
    }
  }

  // Each field can individually be a no-op (a matching state short-circuits
  // above; a matching assignee/label set/project/cycle is skipped). When
  // NOTHING would be sent, report the no-op instead of mutating with an empty
  // input.
  const hasPatch =
    title !== undefined ||
    description !== undefined ||
    stateName !== undefined ||
    priority !== undefined ||
    assigneeId !== undefined ||
    labelIds !== undefined ||
    projectId !== undefined ||
    cycleId !== undefined;
  if (!hasPatch) {
    return renderOutput([
      `issue: ${existing.identifier} already up to date (no-op)`,
    ]);
  }

  const updated = await updateIssue(apiKey, existing.id, {
    title,
    description,
    stateName,
    priority,
    assigneeId,
    labelIds,
    projectId,
    cycleId,
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

/**
 * Render the sub-issues block for `issue view --full` (#26): a count header
 * (the help[N]:-style bracket convention) plus one
 * `identifier | title | state` line per child, in the server's order for the
 * children connection. An empty list still renders the bare header — under
 * --full the user asked for everything, so "no sub-issues" is information,
 * not noise.
 */
function renderSubIssues(
  children: { nodes: LinearIssueChild[] } | null | undefined,
): string {
  const nodes = children?.nodes ?? [];
  const lines = nodes.map(
    (child) =>
      `  ${child.identifier} | ${child.title} | ${child.state?.name ?? 'unknown'}`,
  );
  return `sub-issues[${nodes.length}]:${lines.length ? `\n${lines.join('\n')}` : ''}`;
}

/**
 * Parse a --cycle value: "current" (case-insensitive) or a positive integer
 * cycle number. Same grammar as the `issues` read path (#21); anything else
 * fails loud before any network request.
 */
function parseCycleValue(raw: string): 'current' | number {
  const value = raw.trim().toLowerCase();
  if (value === 'current') return 'current';
  if (/^\d+$/.test(value) && Number(value) >= 1) return Number(value);
  throw new AxiError(`Invalid --cycle: ${raw}`, 'VALIDATION_ERROR', [
    'Use "current" for the active cycle, or a positive cycle number',
  ]);
}

/**
 * Resolve --cycle current to a cycle id (#25 write path). With teamKey (always
 * on create, where --team is required; on update when passed): that team's
 * active cycle. Without (update only): the workspace's active cycles — #21's
 * read path lets "current" match every team's active cycle, but a WRITE must
 * pick exactly one, so more than one active cycle fails loud listing the
 * candidates instead of silently assigning a wrong team's cycle. When the
 * target issue's team is known (update), a resolved cycle belonging to a
 * DIFFERENT team is rejected for the same reason — an issue can only sit in
 * one of its own team's cycles.
 */
async function requireActiveCycleId(
  apiKey: string,
  teamKey?: string,
  issueTeamKey?: string,
): Promise<string> {
  const active = await fetchActiveCycles(apiKey, teamKey);
  const scope = teamKey?.toUpperCase();
  if (active.length === 0) {
    throw new AxiError(
      scope
        ? `Team ${scope} has no active cycle`
        : 'No active cycles in your workspace',
      'VALIDATION_ERROR',
      ['Run `linear-axi cycles` to see cycles'],
    );
  }
  if (active.length > 1) {
    const list = active
      .map((c) => `cycle ${c.number} (${c.teamKey})`)
      .join(', ');
    throw new AxiError(
      scope
        ? `Team ${scope} has ${active.length} active cycles — pick one by number instead`
        : `${active.length} active cycles in your workspace — pass --team <KEY> to pick one`,
      'VALIDATION_ERROR',
      [`Active cycles: ${list}`],
    );
  }
  const match = active[0]!;
  if (
    issueTeamKey &&
    match.teamKey.toUpperCase() !== issueTeamKey.toUpperCase()
  ) {
    throw new AxiError(
      `The only active cycle is cycle ${match.number} of team ${match.teamKey}, but this issue belongs to team ${issueTeamKey}`,
      'VALIDATION_ERROR',
      [
        `Use --cycle <number> --team ${issueTeamKey} to pick one of its own team's cycles`,
      ],
    );
  }
  return match.id;
}

/**
 * Resolve a numbered --cycle to a cycle id, loud on no match (#25 write
 * path). The team key is mandatory — cycle numbers restart per team (same
 * disambiguation as the #21 read path).
 */
async function requireCycleIdByNumber(
  apiKey: string,
  teamKey: string,
  number: number,
): Promise<string> {
  const id = await resolveCycleIdByNumber(apiKey, teamKey, number);
  if (!id) {
    throw new AxiError(
      `Cycle ${number} not found for team ${teamKey.toUpperCase()}`,
      'VALIDATION_ERROR',
      [`Run \`linear-axi cycles --team ${teamKey.toUpperCase()}\` to see cycle numbers`],
    );
  }
  return id;
}
