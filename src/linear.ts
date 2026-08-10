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

export const ISSUE_DETAIL_FIELDS = `
  id
  identifier
  title
  description
  state { name type }
  priority
  assignee { name }
  team { key name id }
  labels { nodes { name } }
  url
  createdAt
  updatedAt
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
  labels?: { nodes: Array<{ name: string }> } | null;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
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

export interface IssueListFilter {
  team?: string; // team key, e.g. "LIN"
  stateType?: string; // backlog | unstarted | started | completed | canceled | triage
  assigneeEmail?: string; // exact email (use viewer email for "me")
  assigneeName?: string; // exact display name
  label?: string; // label name (at least one match)
}

export interface IssueListResult {
  issues: LinearIssue[];
}

/**
 * List issues with an optional filter, most recently updated first.
 *
 * Filter syntax follows Linear's documented comparators, e.g.
 *   assignee: { email: { eq: "x" } }
 *   labels:   { name:  { eq: "Bug" } }
 *   state:    { type:  { eq: "started" } }
 *   team:     { key:   { eq: "LIN" } }
 *
 * There is no `totalCount` on Linear connections, so callers compute the count
 * line from the returned slice (with a truncation hint when `limit` is hit).
 */
export async function fetchIssues(
  apiKey: string,
  filter: IssueListFilter,
  limit = 50,
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
  if (filter.label) {
    where.push(`labels: { name: { eq: ${jsonStr(filter.label)} } }`);
  }

  const filterPart = where.length ? `filter: { ${where.join(', ')} }, ` : '';
  const query = `query Issues($first: Int!) {
    issues(${filterPart}first: $first, orderBy: updatedAt) {
      nodes { ${ISSUE_LIST_FIELDS} }
    }
  }`;

  const data = await linearRequest<{ issues: { nodes: LinearIssue[] } }>(
    apiKey,
    query,
    { first: Math.min(limit, 50) },
  );

  return { issues: data.issues.nodes };
}

/**
 * Fetch a single issue. Linear's `issue(id:)` accepts EITHER a UUID or the
 * human-readable identifier (e.g. "CTZ-311"), so no resolution step is needed.
 */
export async function fetchIssue(
  apiKey: string,
  ref: string,
): Promise<LinearIssue | undefined> {
  const data = await linearRequest<{ issue: LinearIssue | null }>(
    apiKey,
    `query Issue($id: ID!) { issue(id: $id) { ${ISSUE_DETAIL_FIELDS} } }`,
    { id: ref },
  );
  return data.issue ?? undefined;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface IssueCreateInput {
  title: string;
  description?: string;
  teamKey: string;
  labelNames?: string[];
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

  const data = await linearRequest<{
    issueCreate: { issue: LinearIssue; success: boolean };
  }>(
    apiKey,
    `mutation CreateIssue($teamId: ID!, $title: String!, $description: String, $labelIds: [ID!]) {
      issueCreate(input: {
        teamId: $teamId
        title: $title
        description: $description
        labelIds: $labelIds
      }) {
        success
        issue { id identifier title state { name type } team { key } url }
      }
    }`,
    {
      teamId,
      title: input.title,
      description: input.description ?? null,
      labelIds: labelIds.length ? labelIds : null,
    },
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

  const data = await linearRequest<{
    issueUpdate: { issue: LinearIssue; success: boolean };
  }>(
    apiKey,
    `mutation UpdateIssue($id: ID!, $title: String, $description: String, $priority: Float, $stateId: ID) {
      issueUpdate(id: $id, input: {
        title: $title
        description: $description
        priority: $priority
        stateId: $stateId
      }) {
        success
        issue { id identifier title state { name type } team { key } url }
      }
    }`,
    {
      id,
      title: update.title ?? null,
      description: update.description ?? null,
      priority: update.priority ?? null,
      stateId: stateId ?? null,
    },
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
    `mutation DeleteIssue($id: ID!) {
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
    `mutation Comment($issueId: ID!, $body: String!) {
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

async function resolveLabelIds(
  apiKey: string,
  names: string[],
): Promise<string[]> {
  const wanted = names.map((n) => n.trim().toLowerCase());
  const data = await linearRequest<{
    issueLabels: { nodes: Array<{ id: string; name: string }> };
  }>(apiKey, `query Labels { issueLabels { nodes { id name } } }`);
  return data.issueLabels.nodes
    .filter((l) => wanted.includes(l.name.toLowerCase()))
    .map((l) => l.id);
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
    `query TeamStates($id: ID!) {
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

function jsonStr(value: string): string {
  return JSON.stringify(value);
}
