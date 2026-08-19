import { mapLinearError, networkError, AxiError } from './errors.js';

export const LINEAR_API_URL = 'https://api.linear.app/graphql';

/**
 * Raw transport: POST a GraphQL document to Linear with the API key as the
 * Authorization header. Returns the parsed `data` on success; throws an AxiError
 * (translated from HTTP/GraphQL status) otherwise.
 *
 * Set LINEAR_AXI_DEBUG=1 to dump the raw response body to stderr on error,
 * which makes query-shape mistakes debuggable in one round trip.
 */
export async function linearRequest<T = unknown>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(LINEAR_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (cause) {
    throw networkError(cause);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const withErrors = body as { errors?: unknown } | null;
  const hasGqlErrors = withErrors && Array.isArray(withErrors.errors);

  if (!response.ok || hasGqlErrors) {
    if (process.env['LINEAR_AXI_DEBUG'] === '1') {
      console.error('[linear-axi] query:', query);
      console.error('[linear-axi] variables:', JSON.stringify(variables));
      console.error('[linear-axi] raw body:', JSON.stringify(body));
    }
    throw mapLinearError({ status: response.status, body });
  }

  return (body as { data: T }).data;
}

// ---------------------------------------------------------------------------
// GraphQL fragments — plain strings so callers can compose them.
// ---------------------------------------------------------------------------

export const ISSUE_LIST_FIELDS = `
  id
  identifier
  title
  state { name type }
  priority
  assignee { name }
  team { key }
  updatedAt
`;

/**
 * Detail selection for a single issue. Label nodes include `id` because
 * `issue update --label/--remove-label` (#24) needs the issue's CURRENT label
 * ids to compute the union/difference replacement set — names alone cannot be
 * sent back to IssueUpdateInput.labelIds. `project { id name }` and
 * `cycle { id number }` serve the same purpose for #25: update-side no-op
 * detection compares the issue's CURRENT project/cycle ids against the
 * resolved --project/--cycle ids before sending IssueUpdateInput.projectId/
 * cycleId. Renderers read none of the extra keys, so they stay invisible.
 */
export const ISSUE_DETAIL_FIELDS = `
  id
  identifier
  title
  description
  state { name type }
  priority
  assignee { name }
  team { key name id }
  labels { nodes { id name } }
  project { id name }
  cycle { id number }
  url
  createdAt
  updatedAt
`;

/**
 * Append opt-in extra scalar keys (from `--fields`) to a base issue selection
 * set. Returns the base string unchanged when no extras are requested, so the
 * default GraphQL documents stay byte-identical without the flag (opt-in only).
 */
export function withExtraFields(base: string, extraKeys: string[]): string {
  if (extraKeys.length === 0) return base;
  return `${base}${extraKeys.map((k) => `\n  ${k}`).join('')}`;
}

/**
 * Selection for the `projects` connection. We select `status { type }` rather
 * than the deprecated `state` field (Project.state: "[DEPRECATED] Use
 * project.status instead" per @linear/sdk): status.type is a ProjectStatusType
 * enum yielding the same raw lowercase lifecycle values.
 */
export const PROJECT_LIST_FIELDS = `
  id
  name
  status { type }
  progress
  lead { name }
  targetDate
`;

/**
 * Selection for cycle nodes. Only the fields the `cycles` command renders:
 * number (per-team identifier), the date range, and progress. The team key is
 * added by the caller when fetching the root `cycles` connection (cycles from
 * all teams are mixed there and need attribution).
 */
export const CYCLE_LIST_FIELDS = `
  id
  number
  startsAt
  endsAt
  progress
`;

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  state?: { name: string; type: string } | null;
  priority?: number;
  assignee?: { name: string } | null;
  team?: { id?: string; key: string; name?: string } | null;
  // `id` is present when the selection includes it (ISSUE_DETAIL_FIELDS does;
  // ISSUE_LIST_FIELDS selects no labels at all), so it is optional here.
  labels?: { nodes: Array<{ id?: string; name: string }> } | null;
  // Present when selected (ISSUE_DETAIL_FIELDS does, list selections do not):
  // the issue's current project/cycle for #25 update no-op detection. Issue
  // .project and .cycle are nullable object types per @linear/sdk (an issue
  // can be in neither); `cycle.number` mirrors Cycle.number (Float, unique
  // within its team).
  project?: { id: string; name: string } | null;
  cycle?: { id: string; number: number } | null;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  // Opt-in extra fields, present only when selected via --fields. Shapes
  // verified against the generated Issue type in @linear/sdk v90.0.0:
  // estimate is Float|null, dueDate a TimelessDate serialized as YYYY-MM-DD
  // (null when unset), archivedAt an ISO DateTime, branchName a String.
  estimate?: number | null;
  dueDate?: string | null;
  archivedAt?: string | null;
  branchName?: string;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

/**
 * A Linear project as returned by PROJECT_LIST_FIELDS. `status.type` carries
 * the lifecycle state (backlog, planned, started, paused, completed,
 * canceled); `progress` is a float 0-1; `targetDate` is a TimelessDate
 * serialized as YYYY-MM-DD (null when unset). Field shapes verified against
 * the generated types in @linear/sdk (Project, ProjectStatus).
 */
export interface LinearProject {
  id: string;
  name: string;
  status?: { type: string } | null;
  progress?: number;
  lead?: { name: string } | null;
  targetDate?: string | null;
}

/**
 * A Linear cycle as returned by CYCLE_LIST_FIELDS. Cycles are a team's
 * time-boxed iterations: `number` is auto-incrementing and unique within its
 * team (it restarts per team — cycle 42 of LIN and cycle 42 of ENG are
 * different cycles); `progress` is a float 0-1 ("(completed estimate points +
 * 0.25 * in-progress estimate points) / total estimate points", 0 when nothing
 * is estimated); `startsAt`/`endsAt` are ISO DateTimes. Field shapes verified
 * against the generated types in @linear/sdk (Cycle).
 */
export interface LinearCycle {
  id: string;
  number: number;
  startsAt: string;
  endsAt: string;
  progress?: number;
  /** Present when fetched via the root `cycles` connection (absent per-team). */
  team?: { key: string } | null;
}

export interface LinearViewer {
  id: string;
  name: string;
  email: string;
}

// ---------------------------------------------------------------------------
// Read queries
// ---------------------------------------------------------------------------

export async function fetchViewer(apiKey: string): Promise<LinearViewer> {
  const data = await linearRequest<{ viewer: LinearViewer }>(
    apiKey,
    `query { viewer { id name email } }`,
  );
  return data.viewer;
}

export async function fetchTeams(apiKey: string): Promise<LinearTeam[]> {
  const data = await linearRequest<{ teams: { nodes: LinearTeam[] } }>(
    apiKey,
    `query Teams { teams { nodes { id key name } } }`,
  );
  return data.teams.nodes;
}

export interface ProjectListResult {
  projects: LinearProject[];
  /**
   * True when the last fetched page reported `hasNextPage` — more projects
   * exist beyond the returned slice (the fetch limit was hit mid-cursor).
   */
  hasMore: boolean;
}

interface ProjectListPage {
  nodes: LinearProject[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
}

/**
 * List workspace projects, most recently updated first, auto-paginated in
 * PAGE_SIZE (50) batches like fetchIssues until `limit` is satisfied or the
 * server reports no more pages.
 */
export async function fetchProjects(
  apiKey: string,
  limit = 100,
): Promise<ProjectListResult> {
  const query = `query Projects($first: Int!, $after: String) {
    projects(first: $first, after: $after, orderBy: updatedAt) {
      nodes { ${PROJECT_LIST_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }`;

  const projects: LinearProject[] = [];
  let cursor: string | undefined;
  let hasMore = false;

  while (projects.length < limit) {
    const first = Math.min(limit - projects.length, PAGE_SIZE);
    const variables: Record<string, unknown> = { first };
    if (cursor !== undefined) {
      variables['after'] = cursor;
    }

    const data = await linearRequest<{ projects: ProjectListPage }>(
      apiKey,
      query,
      variables,
    );

    projects.push(...data.projects.nodes);

    hasMore = data.projects.pageInfo?.hasNextPage ?? false;
    const nextCursor = data.projects.pageInfo?.endCursor ?? undefined;

    // Same loop guards as fetchIssues: stop on server exhaustion and on a
    // non-advancing cursor or empty page that would otherwise spin forever.
    if (!hasMore || nextCursor === undefined) break;
    if (data.projects.nodes.length === 0 || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  return { projects: projects.slice(0, limit), hasMore };
}

export interface CycleListResult {
  cycles: LinearCycle[];
  /**
   * True when the last fetched page reported `hasNextPage` — more cycles
   * exist beyond the returned slice (the fetch limit was hit mid-cursor).
   */
  hasMore: boolean;
}

interface CycleListPage {
  nodes: LinearCycle[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
}

/**
 * List recent cycles, most recently updated first, auto-paginated in PAGE_SIZE
 * (50) batches like fetchProjects until `limit` is satisfied or the server
 * reports no more pages.
 *
 * With `teamKey`, the team is resolved to its id (resolveTeamId) and its
 * `team(id:) { cycles }` connection is queried. Without, the root `cycles`
 * connection ("all cycles accessible to the user") is queried and each node
 * also selects `team { key }` so mixed-team rows can be attributed — one
 * request instead of one per team. Both connections take the same args
 * (filter/first/after/orderBy: PaginationOrderBy) per @linear/sdk
 * (TeamCyclesArgs, QueryCyclesArgs); PaginationOrderBy only offers
 * createdAt/updatedAt, so updatedAt is the recent-first ordering, matching
 * issues and projects.
 *
 * An unknown team key fails loud rather than silently returning nothing.
 */
export async function fetchCycles(
  apiKey: string,
  teamKey?: string,
  limit = 10,
): Promise<CycleListResult> {
  let teamId: string | undefined;
  if (teamKey !== undefined) {
    teamId = await resolveTeamId(apiKey, teamKey);
    if (!teamId) {
      throw new AxiError(
        `Team "${teamKey}" not found in your workspace`,
        'VALIDATION_ERROR',
        ['Run `linear-axi teams` to see available team keys'],
      );
    }
  }

  const perTeam = teamId !== undefined;
  const query = perTeam
    ? `query TeamCycles($id: String!, $first: Int!, $after: String) {
        team(id: $id) {
          cycles(first: $first, after: $after, orderBy: updatedAt) {
            nodes { ${CYCLE_LIST_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`
    : `query Cycles($first: Int!, $after: String) {
        cycles(first: $first, after: $after, orderBy: updatedAt) {
          nodes { ${CYCLE_LIST_FIELDS} team { key } }
          pageInfo { hasNextPage endCursor }
        }
      }`;

  const cycles: LinearCycle[] = [];
  let cursor: string | undefined;
  let hasMore = false;

  while (cycles.length < limit) {
    const first = Math.min(limit - cycles.length, PAGE_SIZE);
    const variables: Record<string, unknown> = perTeam
      ? { id: teamId, first }
      : { first };
    if (cursor !== undefined) {
      variables['after'] = cursor;
    }

    const data = await linearRequest<{
      team?: { cycles?: CycleListPage } | null;
      cycles?: CycleListPage;
    }>(apiKey, query, variables);

    const conn = (perTeam ? data.team?.cycles : data.cycles) as CycleListPage;
    cycles.push(...conn.nodes);

    hasMore = conn.pageInfo?.hasNextPage ?? false;
    const nextCursor = conn.pageInfo?.endCursor ?? undefined;

    // Same loop guards as fetchIssues/fetchProjects.
    if (!hasMore || nextCursor === undefined) break;
    if (conn.nodes.length === 0 || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  return { cycles: cycles.slice(0, limit), hasMore };
}

export interface IssueListFilter {
  team?: string; // team key, e.g. "LIN"
  stateType?: string; // backlog | unstarted | started | completed | canceled | triage
  assigneeEmail?: string; // exact email (use viewer email for "me")
  assigneeName?: string; // exact display name
  labels?: string[]; // label names — matches issues carrying ANY of them
  project?: string; // project name — exact match
  cycle?: 'current' | number; // 'current' = any team's active cycle; a number is per-team (compose with team)
  search?: string; // ranked full-text search term (Linear app search ranking)
}

export interface IssueListResult {
  issues: LinearIssue[];
  /**
   * True when the last fetched page reported `hasNextPage` — more results
   * exist beyond the returned slice (e.g. the `--limit` was hit mid-cursor).
   */
  hasMore: boolean;
}

/** Linear caps connection pages at 50; fetchIssues auto-paginates in this size. */
const PAGE_SIZE = 50;

interface IssueListPage {
  nodes: LinearIssue[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
}

/**
 * List issues with an optional filter, most recently updated first.
 *
 * Filter syntax follows Linear's documented comparators, e.g.
 *   assignee: { email: { eq: "x" } }
 *   labels:   { some: { name: { in: ["Bug", "Regression"] } } }
 *   state:    { type:  { eq: "started" } }
 *   team:     { key:   { eq: "LIN" } }
 *   project:  { name:  { eq: "Mobile app" } }
 *   cycle:    { isActive: { eq: true } }   // the active cycle(s)
 *   cycle:    { number:  { eq: 42 } }      // a per-team cycle number
 *
 * `labels` uses `some: { name: { in: [...] } }` — an issue matches when at
 * least one of its labels is in the list ("any of" semantics). Shape verified
 * against the generated schema types in @linear/sdk: IssueFilter.labels is an
 * IssueLabelCollectionFilter whose `some` takes an IssueLabelFilter with a
 * `name` StringComparator exposing `in`.
 *
 * Results are auto-paginated: each request fetches up to PAGE_SIZE (50) nodes
 * via `pageInfo { hasNextPage endCursor }` and follows the cursor until
 * `limit` is satisfied or the server reports no more pages.
 *
 * When `filter.search` is set, Linear's ranked full-text search is used
 * instead (same ranking as the Linear app's search). We query `searchIssues`
 * rather than the `issueSearch` root field: both accept the same
 * `filter: IssueFilter` + `first`/`after` paging, but Linear marks
 * `issueSearch` as deprecated ("will be removed in the future — use
 * searchIssues instead"), and its nodes carry the same fields as `Issue` for
 * our selection set.
 *
 * There is no usable `totalCount` on the `issues` connection, so callers
 * compute the count line from the returned slice (`hasMore` in the result
 * says whether a truncation hint is warranted).
 *
 * `extraFields` is a list of opt-in extra scalar Issue keys (from `--fields`)
 * appended to the node selection; the default document is used when empty.
 * It applies to both the `issues` and the `searchIssues` (filter.search)
 * documents — both return Issue nodes.
 */
export async function fetchIssues(
  apiKey: string,
  filter: IssueListFilter,
  limit = 50,
  extraFields: string[] = [],
): Promise<IssueListResult> {
  const where: string[] = [];

  if (filter.assigneeEmail) {
    where.push(`assignee: { email: { eq: ${jsonStr(filter.assigneeEmail)} } }`);
  }
  if (filter.assigneeName) {
    where.push(`assignee: { name: { eq: ${jsonStr(filter.assigneeName)} } }`);
  }
  if (filter.team) {
    where.push(`team: { key: { eq: ${jsonStr(filter.team.toUpperCase())} } }`);
  }
  if (filter.stateType) {
    where.push(`state: { type: { eq: ${jsonStr(filter.stateType)} } }`);
  }
  if (filter.project) {
    where.push(`project: { name: { eq: ${jsonStr(filter.project)} } }`);
  }
  if (filter.labels?.length) {
    where.push(`labels: { some: { name: { in: ${jsonStr(filter.labels)} } } }`);
  }
  if (filter.cycle !== undefined) {
    // IssueFilter.cycle is a NullableCycleFilter (verified against the
    // generated types in @linear/sdk): isActive is a BooleanComparator
    // (eq/neq) and number is a NumberComparator with eq, so both shapes below
    // are schema-valid — no cycle-id resolution round trip is needed.
    where.push(
      filter.cycle === 'current'
        ? `cycle: { isActive: { eq: true } }`
        : `cycle: { number: { eq: ${filter.cycle} } }`,
    );
  }

  const filterPart = where.length ? `filter: { ${where.join(', ')} }, ` : '';
  const isSearch = filter.search !== undefined;
  const selection = withExtraFields(ISSUE_LIST_FIELDS, extraFields);

  const query = isSearch
    ? `query SearchIssues($term: String!, $first: Int!, $after: String) {
        searchIssues(term: $term, ${filterPart}first: $first, after: $after) {
          nodes { ${selection} }
          pageInfo { hasNextPage endCursor }
        }
      }`
    : `query Issues($first: Int!, $after: String) {
        issues(${filterPart}first: $first, after: $after, orderBy: updatedAt) {
          nodes { ${selection} }
          pageInfo { hasNextPage endCursor }
        }
      }`;

  const issues: LinearIssue[] = [];
  let cursor: string | undefined;
  let hasMore = false;

  // Auto-paginate until `limit` is satisfied. Each page asks for only the
  // remaining slots (capped at PAGE_SIZE) so we never over-fetch.
  while (issues.length < limit) {
    const first = Math.min(limit - issues.length, PAGE_SIZE);
    const variables: Record<string, unknown> = isSearch
      ? { term: filter.search, first }
      : { first };
    if (cursor !== undefined) {
      variables['after'] = cursor;
    }

    const data = await linearRequest<{
      issues?: IssueListPage;
      searchIssues?: IssueListPage;
    }>(apiKey, query, variables);

    const conn = (isSearch ? data.searchIssues : data.issues) as IssueListPage;
    issues.push(...conn.nodes);

    hasMore = conn.pageInfo?.hasNextPage ?? false;
    const nextCursor = conn.pageInfo?.endCursor ?? undefined;

    // Stop when the server says we are done, and guard against a server that
    // keeps hasNextPage true without a usable (present, advancing) cursor or
    // without nodes — both would loop forever.
    if (!hasMore || nextCursor === undefined) break;
    if (conn.nodes.length === 0 || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  return { issues: issues.slice(0, limit), hasMore };
}

/**
 * Fetch a single issue. Linear's `issue(id:)` accepts EITHER a UUID or the
 * human-readable identifier (e.g. "CTZ-311"), so no resolution step is needed.
 *
 * `extraFields` is a list of opt-in extra scalar Issue keys (from `--fields`)
 * appended to the selection; the default document is used when empty.
 */
export async function fetchIssue(
  apiKey: string,
  ref: string,
  extraFields: string[] = [],
): Promise<LinearIssue | undefined> {
  const data = await linearRequest<{ issue: LinearIssue | null }>(
    apiKey,
    `query Issue($id: String!) { issue(id: $id) { ${withExtraFields(ISSUE_DETAIL_FIELDS, extraFields)} } }`,
    { id: ref },
  );
  return data.issue ?? undefined;
}

/** Selection for comment nodes. The author is `user` for workspace comments,
 * `externalUser` for comments created through integrations (Slack, Intercom). */
export const COMMENT_LIST_FIELDS = `
  id
  body
  user { name }
  externalUser { displayName }
  createdAt
`;

/**
 * A Linear comment as returned by COMMENT_LIST_FIELDS. Exactly one of
 * user/externalUser is set for real comments (Comment.user is nullable:
 * "null for comments created by integrations or bots without a user
 * association" per @linear/sdk); both are absent in fixtures only.
 */
export interface LinearComment {
  id: string;
  body: string;
  user?: { name: string } | null;
  externalUser?: { displayName: string } | null;
  createdAt: string;
}

export interface CommentListResult {
  comments: LinearComment[];
  /**
   * True when the last fetched page reported `hasNextPage` — more comments
   * exist beyond the returned slice (the fetch limit was hit mid-cursor).
   */
  hasMore: boolean;
}

interface CommentListPage {
  nodes: LinearComment[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
}

/**
 * List one issue's comments, newest first.
 *
 * The root `comments` connection has no `issueId` argument in current
 * @linear/sdk (v90.0.0 QueryCommentsArgs: after/before/filter/first/
 * includeArchived/last/orderBy) — the thread is scoped through
 * `filter: { issue: { id: { eq: ... } } }` (CommentFilter.issue is a
 * NullableIssueFilter; IssueFilter.id is an IssueIdComparator with eq: ID).
 *
 * Ordering: PaginationOrderBy only offers createdAt/updatedAt and Linear's
 * connections sort descending (newest first — Linear's pagination docs and
 * the repo's fetchIssues/fetchProjects/fetchCycles precedent; the
 * Ascending/Descending PaginationSortOrder enum in the SDK is not an arg on
 * this connection). `orderBy: createdAt` therefore returns the newest
 * comment first without any client-side reversing, and stays the stable
 * thread order (an edited old comment does not jump to the top, which
 * `updatedAt` ordering would cause).
 *
 * Auto-paginates in PAGE_SIZE (50) batches like fetchIssues until `limit` is
 * satisfied or the server reports no more pages.
 */
export async function fetchComments(
  apiKey: string,
  issueId: string,
  limit = 100,
): Promise<CommentListResult> {
  const query = `query Comments($issueId: ID!, $first: Int!, $after: String) {
    comments(filter: { issue: { id: { eq: $issueId } } }, first: $first, after: $after, orderBy: createdAt) {
      nodes { ${COMMENT_LIST_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }`;

  const comments: LinearComment[] = [];
  let cursor: string | undefined;
  let hasMore = false;

  while (comments.length < limit) {
    const first = Math.min(limit - comments.length, PAGE_SIZE);
    const variables: Record<string, unknown> = { issueId, first };
    if (cursor !== undefined) {
      variables['after'] = cursor;
    }

    const data = await linearRequest<{ comments: CommentListPage }>(
      apiKey,
      query,
      variables,
    );

    comments.push(...data.comments.nodes);

    hasMore = data.comments.pageInfo?.hasNextPage ?? false;
    const nextCursor = data.comments.pageInfo?.endCursor ?? undefined;

    // Same loop guards as fetchIssues/fetchProjects/fetchCycles.
    if (!hasMore || nextCursor === undefined) break;
    if (data.comments.nodes.length === 0 || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  return { comments: comments.slice(0, limit), hasMore };
}

/** Selection for label nodes. `color` is a raw HEX string (see LinearLabel). */
export const LABEL_LIST_FIELDS = `
  id
  name
  color
`;

/**
 * A Linear issue label as returned by LABEL_LIST_FIELDS. Labels can be
 * workspace-level or team-scoped; `color` is a HEX string like "#EB5757"
 * ("The label's color as a HEX string (e.g., '#EB5757')" per the generated
 * IssueLabel type in @linear/sdk, where color is a non-nullable String).
 * Rendered raw — terminal color support varies, so no ANSI swatch is
 * attempted.
 */
export interface LinearLabel {
  id: string;
  name: string;
  color: string;
}

export interface LabelListResult {
  labels: LinearLabel[];
  /**
   * True when the last fetched page reported `hasNextPage` — more labels
   * exist beyond the returned slice (the fetch limit was hit mid-cursor).
   */
  hasMore: boolean;
}

interface LabelListPage {
  nodes: LinearLabel[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
}

/**
 * List the workspace's issue labels, most recently updated first,
 * auto-paginated in PAGE_SIZE (50) batches like fetchProjects until `limit`
 * is satisfied or the server reports no more pages. The root `issueLabels`
 * connection takes the same after/filter/first/orderBy args as the other
 * list connections (QueryIssueLabelsArgs in @linear/sdk); PaginationOrderBy
 * only offers createdAt/updatedAt, so updatedAt is the recent-first
 * ordering, matching issues, projects, and cycles. The default limit (500)
 * is generous for real workspaces while still guarding a runaway cursor;
 * `hasMore` in the result says whether truncation occurred.
 */
export async function fetchLabels(
  apiKey: string,
  limit = 500,
): Promise<LabelListResult> {
  const query = `query Labels($first: Int!, $after: String) {
    issueLabels(first: $first, after: $after, orderBy: updatedAt) {
      nodes { ${LABEL_LIST_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }`;

  const labels: LinearLabel[] = [];
  let cursor: string | undefined;
  let hasMore = false;

  while (labels.length < limit) {
    const first = Math.min(limit - labels.length, PAGE_SIZE);
    const variables: Record<string, unknown> = { first };
    if (cursor !== undefined) {
      variables['after'] = cursor;
    }

    const data = await linearRequest<{ issueLabels: LabelListPage }>(
      apiKey,
      query,
      variables,
    );

    labels.push(...data.issueLabels.nodes);

    hasMore = data.issueLabels.pageInfo?.hasNextPage ?? false;
    const nextCursor = data.issueLabels.pageInfo?.endCursor ?? undefined;

    // Same loop guards as fetchIssues/fetchProjects/fetchCycles/fetchComments.
    if (!hasMore || nextCursor === undefined) break;
    if (data.issueLabels.nodes.length === 0 || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  return { labels: labels.slice(0, limit), hasMore };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface IssueCreateInput {
  title: string;
  description?: string;
  teamKey: string;
  labelNames?: string[];
  /**
   * Put the issue in this project (resolved by the caller from --project via
   * requireProjectId). IssueCreateInput.projectId is a nullable String
   * ("The project associated with the issue", @linear/sdk v90).
   */
  projectId?: string;
  /**
   * Put the issue in this cycle (resolved by the caller from --cycle).
   * IssueCreateInput.cycleId is a nullable String ("The cycle associated with
   * the issue", @linear/sdk v90).
   */
  cycleId?: string;
}

export async function createIssue(
  apiKey: string,
  input: IssueCreateInput,
): Promise<LinearIssue> {
  const teamId = await resolveTeamId(apiKey, input.teamKey);
  if (!teamId) {
    throw new AxiError(
      `Team "${input.teamKey}" not found in your workspace`,
      'VALIDATION_ERROR',
      ['Run `linear-axi teams` to see available team keys'],
    );
  }

  const labelIds = input.labelNames?.length
    ? await resolveLabelIds(apiKey, input.labelNames)
    : [];

  // Linear's IssueCreateInput rejects `null` for optional fields (notably
  // labelIds: "should not be null"). Build the input with only the fields that
  // have values, declaring a matching variable for each.
  const inputFields = ['teamId: $teamId', 'title: $title'];
  const varDecls = ['$teamId: String!', '$title: String!'];
  const variables: Record<string, unknown> = { teamId, title: input.title };

  if (input.description !== undefined) {
    inputFields.push('description: $description');
    varDecls.push('$description: String');
    variables['description'] = input.description;
  }
  if (labelIds.length) {
    inputFields.push('labelIds: $labelIds');
    varDecls.push('$labelIds: [String!]');
    variables['labelIds'] = labelIds;
  }
  // projectId/cycleId (#25) follow the same omit-null convention: declared
  // and sent only when the caller resolved an id.
  if (input.projectId !== undefined) {
    inputFields.push('projectId: $projectId');
    varDecls.push('$projectId: String');
    variables['projectId'] = input.projectId;
  }
  if (input.cycleId !== undefined) {
    inputFields.push('cycleId: $cycleId');
    varDecls.push('$cycleId: String');
    variables['cycleId'] = input.cycleId;
  }

  const data = await linearRequest<{
    issueCreate: { issue: LinearIssue; success: boolean };
  }>(
    apiKey,
    `mutation CreateIssue(${varDecls.join(', ')}) {
      issueCreate(input: { ${inputFields.join(', ')} }) {
        success
        issue { id identifier title state { name type } team { key } url }
      }
    }`,
    variables,
  );

  if (!data.issueCreate.success) {
    throw new AxiError('Linear rejected the issue create', 'UNKNOWN');
  }
  return data.issueCreate.issue;
}

export interface IssueUpdate {
  title?: string;
  description?: string;
  stateName?: string;
  priority?: number;
  /**
   * Assign the issue to this user id. Undefined leaves the assignee
   * untouched; Linear's IssueUpdateInput.assigneeId is a nullable String
   * ("The identifier of the user to assign the issue to", @linear/sdk v90).
   */
  assigneeId?: string;
  /**
   * FULL REPLACEMENT label-id set — Linear's IssueUpdateInput.labelIds
   * replaces the issue's labels wholesale ("The identifiers of the issue
   * labels associated with this ticket", @linear/sdk v90). Callers compute
   * union/difference against the issue's current ids. An EMPTY ARRAY IS
   * SENT EXPLICITLY (removing the last label must work); only undefined
   * means "leave labels alone".
   */
  labelIds?: string[];
  /**
   * Move the issue into this project (resolved by the caller from --project
   * via requireProjectId). IssueUpdateInput.projectId is a nullable String
   * ("The project associated with the issue", @linear/sdk v90); undefined
   * leaves the project untouched.
   */
  projectId?: string;
  /**
   * Move the issue into this cycle (resolved by the caller from --cycle).
   * IssueUpdateInput.cycleId is a nullable String ("The cycle associated
   * with the issue", @linear/sdk v90); undefined leaves the cycle untouched.
   */
  cycleId?: string;
}

/**
 * Update an issue. `id` accepts a UUID or identifier (Linear resolves both).
 * If `stateName` is given, it is resolved to a workflow state id via the
 * issue's team states.
 */
export async function updateIssue(
  apiKey: string,
  id: string,
  update: IssueUpdate,
): Promise<LinearIssue> {
  let stateId: string | undefined;
  if (update.stateName) {
    stateId = await resolveStateIdByName(apiKey, id, update.stateName);
  }

  // Build the input from only the fields that have values — Linear rejects
  // `null` for some optional IssueUpdateInput fields (same class of error as
  // create's labelIds).
  const inputFields: string[] = [];
  const varDecls = ['$id: String!'];
  const variables: Record<string, unknown> = { id };

  if (update.title !== undefined) {
    inputFields.push('title: $title');
    varDecls.push('$title: String');
    variables['title'] = update.title;
  }
  if (update.description !== undefined) {
    inputFields.push('description: $description');
    varDecls.push('$description: String');
    variables['description'] = update.description;
  }
  if (update.priority !== undefined) {
    inputFields.push('priority: $priority');
    varDecls.push('$priority: Int');
    variables['priority'] = update.priority;
  }
  if (stateId !== undefined) {
    inputFields.push('stateId: $stateId');
    varDecls.push('$stateId: String');
    variables['stateId'] = stateId;
  }
  // assigneeId/labelIds follow the same omit-null convention as above, with
  // one deliberate exception: labelIds === [] IS included — an explicit
  // removal of the last label must reach Linear as an empty replacement set,
  // not be skipped like a null optional.
  if (update.assigneeId !== undefined) {
    inputFields.push('assigneeId: $assigneeId');
    varDecls.push('$assigneeId: String');
    variables['assigneeId'] = update.assigneeId;
  }
  if (update.labelIds !== undefined) {
    inputFields.push('labelIds: $labelIds');
    varDecls.push('$labelIds: [String!]');
    variables['labelIds'] = update.labelIds;
  }
  // projectId/cycleId (#25) follow the same omit-null convention as above.
  if (update.projectId !== undefined) {
    inputFields.push('projectId: $projectId');
    varDecls.push('$projectId: String');
    variables['projectId'] = update.projectId;
  }
  if (update.cycleId !== undefined) {
    inputFields.push('cycleId: $cycleId');
    varDecls.push('$cycleId: String');
    variables['cycleId'] = update.cycleId;
  }

  const data = await linearRequest<{
    issueUpdate: { issue: LinearIssue; success: boolean };
  }>(
    apiKey,
    `mutation UpdateIssue(${varDecls.join(', ')}) {
      issueUpdate(id: $id, input: { ${inputFields.join(', ')} }) {
        success
        issue { id identifier title state { name type } team { key } url }
      }
    }`,
    variables,
  );

  if (!data.issueUpdate.success) {
    throw new AxiError('Linear rejected the issue update', 'UNKNOWN');
  }
  return data.issueUpdate.issue;
}

export async function deleteIssue(apiKey: string, id: string): Promise<void> {
  const data = await linearRequest<{
    issueDelete: { success: boolean };
  }>(
    apiKey,
    `mutation DeleteIssue($id: String!) {
      issueDelete(id: $id) { success }
    }`,
    { id },
  );
  if (!data.issueDelete.success) {
    throw new AxiError('Linear rejected the issue delete', 'UNKNOWN');
  }
}

export async function createComment(
  apiKey: string,
  issueId: string,
  body: string,
): Promise<void> {
  const data = await linearRequest<{
    commentCreate: { success: boolean };
  }>(
    apiKey,
    `mutation Comment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
      }
    }`,
    { issueId, body },
  );
  if (!data.commentCreate.success) {
    throw new AxiError('Linear rejected the comment', 'UNKNOWN');
  }
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

export async function resolveTeamId(
  apiKey: string,
  teamKey: string,
): Promise<string | undefined> {
  const data = await linearRequest<{
    teams: { nodes: Array<{ id: string; key: string }> };
  }>(
    apiKey,
    `query TeamByKey($key: String!) {
      teams(filter: { key: { eq: $key } }) { nodes { id key } }
    }`,
    { key: teamKey.toUpperCase() },
  );
  return data.teams.nodes[0]?.id;
}

/**
 * Resolve a project name (exact match) to its id. Mirrors resolveTeamId;
 * currently exercised by tests and reserved for v0.3 write-side project
 * assignment (e.g. issue create --project). ProjectFilter.name is a
 * StringComparator with `eq` (verified against @linear/sdk).
 */
export async function resolveProjectId(
  apiKey: string,
  name: string,
): Promise<string | undefined> {
  const data = await linearRequest<{
    projects: { nodes: Array<{ id: string; name: string }> };
  }>(
    apiKey,
    `query ProjectByName($name: String!) {
      projects(filter: { name: { eq: $name } }) { nodes { id name } }
    }`,
    { name },
  );
  return data.projects.nodes[0]?.id;
}

/**
 * Write-path project resolution (#25): resolveProjectId, but LOUD on no match.
 * Silently creating/updating an issue without its requested project would
 * surprise far more than a failed command (AXI principle 6), so mutations
 * follow resolveStateIdByName/resolveUserId's loud convention while the read
 * path keeps resolveProjectId's silent-undefined semantics.
 */
export async function requireProjectId(
  apiKey: string,
  name: string,
): Promise<string> {
  const id = await resolveProjectId(apiKey, name);
  if (!id) {
    throw new AxiError(
      `Project "${name}" not found in your workspace`,
      'VALIDATION_ERROR',
      ['Run `linear-axi projects` to see project names (exact match required)'],
    );
  }
  return id;
}

/** An active cycle as returned by fetchActiveCycles. */
export interface ActiveCycle {
  id: string;
  number: number;
  /**
   * Key of the team the cycle belongs to — Cycle.team is non-nullable
   * ("The team that the cycle belongs to. Each cycle is scoped to exactly one
   * team", @linear/sdk), so the workspace-wide query can attribute every
   * active cycle to its team.
   */
  teamKey: string;
}

/**
 * The active cycles of the workspace (or of one team) for write-side
 * `--cycle current` resolution (#25). Uses the root `cycles` connection with
 * `filter: CycleFilter` (QueryCyclesArgs in @linear/sdk v90): isActive is a
 * BooleanComparator with eq (the same comparator the #21 read path puts in
 * IssueFilter.cycle), and team is a TeamFilter, so `team: { key: { eq } }`
 * scopes to one team — the same key comparator resolveTeamId relies on. One
 * round trip either way; a team has at most one active cycle in practice, but
 * callers decide what multiple matches mean (the workspace-wide form returns
 * one per team with cycling enabled).
 */
export async function fetchActiveCycles(
  apiKey: string,
  teamKey?: string,
): Promise<ActiveCycle[]> {
  const perTeam = teamKey !== undefined;
  const query = perTeam
    ? `query TeamActiveCycles($teamKey: String!) {
        cycles(filter: { isActive: { eq: true }, team: { key: { eq: $teamKey } } }) {
          nodes { id number team { key } }
        }
      }`
    : `query ActiveCycles {
        cycles(filter: { isActive: { eq: true } }) { nodes { id number team { key } } }
      }`;
  const data = await linearRequest<{
    cycles: {
      nodes: Array<{ id: string; number: number; team: { key: string } }>;
    };
  }>(apiKey, query, perTeam ? { teamKey: teamKey.toUpperCase() } : {});
  return data.cycles.nodes.map((n) => ({
    id: n.id,
    number: n.number,
    teamKey: n.team.key,
  }));
}

/**
 * Resolve a team's cycle NUMBER to its id (#25 write path). Cycle numbers are
 * "unique within its team" and restart per team (Cycle.number,
 * @linear/sdk v90), so the team key is mandatory — the same disambiguation
 * the #21 read path enforces. CycleFilter.number is a NumberComparator whose
 * eq takes a Float. Returns undefined when the team has no cycle with that
 * number (callers fail loud — a mutation must not silently skip the cycle).
 */
export async function resolveCycleIdByNumber(
  apiKey: string,
  teamKey: string,
  number: number,
): Promise<string | undefined> {
  const data = await linearRequest<{
    cycles: { nodes: Array<{ id: string }> };
  }>(
    apiKey,
    `query CycleByNumber($number: Float!, $teamKey: String!) {
      cycles(filter: { number: { eq: $number }, team: { key: { eq: $teamKey } } }) {
        nodes { id }
      }
    }`,
    { number, teamKey: teamKey.toUpperCase() },
  );
  return data.cycles.nodes[0]?.id;
}

/**
 * Resolve label names to their ids, case-insensitively, in server order.
 * Reuses fetchLabels (auto-paginated) so label resolution keeps working in
 * workspaces with more than one page (50) of labels — the old inline query
 * here fetched a single unpaginated page and silently missed the rest.
 * Unknown names are silently skipped (same semantics as issue create).
 */
export async function resolveLabelIds(
  apiKey: string,
  names: string[],
): Promise<string[]> {
  const { labels } = await fetchLabels(apiKey);
  const wanted = names.map((n) => n.trim().toLowerCase());
  return labels
    .filter((l) => wanted.includes(l.name.toLowerCase()))
    .map((l) => l.id);
}

/**
 * Resolve a user's display name (exact match) to their id for
 * `issue update --assignee <name>` (#24). Query shape verified against the
 * generated documents in @linear/sdk v90: Query.users takes
 * `filter: UserFilter` where UserFilter.name is a StringComparator with `eq`,
 * and the User type exposes id (ID), name, email — all selected here.
 *
 * Fails loud on both no-match and multi-match (display names are not unique
 * in Linear), listing the matched candidates like resolveStateIdByName lists
 * available states.
 */
export async function resolveUserId(
  apiKey: string,
  name: string,
): Promise<string> {
  const data = await linearRequest<{
    users: { nodes: Array<{ id: string; name: string; email: string }> };
  }>(
    apiKey,
    `query UserByName($name: String!) {
      users(filter: { name: { eq: $name } }) { nodes { id name email } }
    }`,
    { name },
  );

  const nodes = data.users.nodes;
  if (nodes.length === 0) {
    throw new AxiError(
      `User "${name}" not found in your workspace`,
      'VALIDATION_ERROR',
      ['Use the exact display name, or "me" for yourself'],
    );
  }
  if (nodes.length > 1) {
    const candidates = nodes
      .map((u) => `${u.name} <${u.email}>`)
      .join(', ');
    throw new AxiError(
      `User "${name}" matches ${nodes.length} users`,
      'VALIDATION_ERROR',
      [`Candidates: ${candidates}`],
    );
  }
  return nodes[0]!.id;
}

async function resolveStateIdByName(
  apiKey: string,
  issueRef: string,
  stateName: string,
): Promise<string> {
  const issue = await fetchIssue(apiKey, issueRef);
  const teamId = issue?.team?.id;
  if (!teamId) throw new AxiError('Could not resolve team for issue', 'UNKNOWN');

  const data = await linearRequest<{
    team: {
      states: { nodes: Array<{ id: string; name: string; type: string }> };
    };
  }>(
    apiKey,
    `query TeamStates($id: String!) {
      team(id: $id) { states { nodes { id name type } } }
    }`,
    { id: teamId },
  );

  const lower = stateName.toLowerCase();
  const match = data.team.states.nodes.find(
    (s) => s.name.toLowerCase() === lower,
  );
  if (!match) {
    const available = data.team.states.nodes.map((s) => s.name).join(', ');
    throw new AxiError(
      `State "${stateName}" not found for this team`,
      'VALIDATION_ERROR',
      [`Available states: ${available}`],
    );
  }
  return match.id;
}

function jsonStr(value: string | string[]): string {
  return JSON.stringify(value);
}
