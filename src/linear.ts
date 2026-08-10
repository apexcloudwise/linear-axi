import { mapLinearError, networkError, AxiError } from './errors.js';

export const LINEAR_API_URL = 'https://api.linear.app/graphql';

/**
 * Raw transport: POST a GraphQL document to Linear with the API key as the
 * Authorization header. Returns the parsed JSON body on 2xx; throws an AxiError
 * (translated from HTTP/GraphQL status) otherwise.
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

  if (!response.ok) {
    throw mapLinearError({ status: response.status, body });
  }

  const withErrors = body as { errors?: unknown };
  if (withErrors && Array.isArray(withErrors.errors)) {
    throw mapLinearError({ status: response.status, body });
  }

  return (body as { data: T }).data;
}

// ---------------------------------------------------------------------------
// GraphQL fragments — kept as plain strings so they can be composed by callers.
// ---------------------------------------------------------------------------

export const ISSUE_LIST_FIELDS = `
  id
  identifier
  title
  state { name type }
  priority
  assignee { name }
  team { key }
`;

export const ISSUE_DETAIL_FIELDS = `
  id
  identifier
  title
  description
  state { name type }
  priority
  assignee { name }
  team { key name }
  labels { nodes { name } }
  url
  createdAt
  updatedAt
  cycle { id name }
`;

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  state?: { name: string; type: string } | null;
  priority?: number;
  assignee?: { name: string } | null;
  team?: { key: string; name?: string } | null;
  labels?: { nodes: Array<{ name: string }> } | null;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  cycle?: { id: string; name: string } | null;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
  states?: { nodes: Array<{ id: string; name: string; type: string }> } | null;
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
  stateType?: string; // unstarted | started | completed | canceled | triage | backlog
  assigneeIsMe?: boolean;
  assigneeName?: string;
  label?: string;
}

/**
 * Resolve a team key (e.g. "LIN") into a team UUID. Returns undefined when no
 * match exists (the caller decides whether that is an error).
 */
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

export interface IssueListResult {
  issues: LinearIssue[];
  totalCount: number;
}

/**
 * List issues with an optional filter set. Uses Linear's `issues` connection
 * with nested comparators. `limit` caps `first:` (Linear caps at 50/page).
 */
export async function fetchIssues(
  apiKey: string,
  filter: IssueListFilter,
  limit = 50,
): Promise<IssueListResult> {
  const where: string[] = [];

  if (filter.assigneeIsMe) {
    where.push('assignee: { isMe: { eq: true } }');
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
    where.push(
      `labels: { some: { name: { eq: ${jsonStr(filter.label)} } } }`,
    );
  }

  const filterPart = where.length ? `filter: { ${where.join(', ')} }, ` : '';
  const query = `query Issues($first: Int!) {
    issues(${filterPart}first: $first, orderBy: updatedAt) {
      nodes { ${ISSUE_LIST_FIELDS} }
      totalCount
    }
  }`;

  const data = await linearRequest<{
    issues: { nodes: LinearIssue[]; totalCount: number };
  }>(apiKey, query, { first: Math.min(limit, 50) });

  return { issues: data.issues.nodes, totalCount: data.issues.totalCount };
}

/**
 * Fetch a single issue. Accepts a UUID directly, or resolves an identifier
 * ("LIN-123") to its UUID via the issues filter before fetching detail.
 */
export async function fetchIssue(
  apiKey: string,
  ref: { kind: 'uuid'; id: string } | { kind: 'identifier'; team: string; number: number },
): Promise<LinearIssue | undefined> {
  if (ref.kind === 'uuid') {
    const data = await linearRequest<{ issue: LinearIssue | null }>(
      apiKey,
      `query Issue($id: ID!) { issue(id: $id) { ${ISSUE_DETAIL_FIELDS} } }`,
      { id: ref.id },
    );
    return data.issue ?? undefined;
  }

  // Identifier → resolve to id via the issues connection.
  const data = await linearRequest<{
    issues: { nodes: LinearIssue[] };
  }>(
    apiKey,
    `query IssueByIdentifier($teamKey: String!, $number: Int!) {
      issues(
        filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } },
        first: 1
      ) { nodes { id } }
    }`,
    { teamKey: ref.team, number: ref.number },
  );

  const id = data.issues.nodes[0]?.id;
  if (!id) return undefined;

  const detail = await linearRequest<{ issue: LinearIssue | null }>(
    apiKey,
    `query Issue($id: ID!) { issue(id: $id) { ${ISSUE_DETAIL_FIELDS} } }`,
    { id },
  );
  return detail.issue ?? undefined;
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

  // Resolve label ids by name (best-effort, ignore unknowns).
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

export async function updateIssue(
  apiKey: string,
  id: string,
  update: IssueUpdate,
): Promise<LinearIssue> {
  // Resolve a human state name (e.g. "In Progress") to a workflow state id.
  let stateId: string | undefined;
  if (update.stateName) {
    stateId = await resolveStateId(apiKey, id, update.stateName);
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

async function resolveLabelIds(
  apiKey: string,
  names: string[],
): Promise<string[]> {
  const wanted = names.map((n) => n.trim().toLowerCase());
  const data = await linearRequest<{
    issueLabels: { nodes: Array<{ id: string; name: string }> };
  }>(
    apiKey,
    `query Labels { issueLabels { nodes { id name } } }`,
  );
  return data.issueLabels.nodes
    .filter((l) => wanted.includes(l.name.toLowerCase()))
    .map((l) => l.id);
}

async function resolveStateId(
  apiKey: string,
  issueId: string,
  stateName: string,
): Promise<string> {
  // Find the issue's team, then that team's workflow states.
  const issue = await linearRequest<{ issue: { team: { id: string } } | null }>(
    apiKey,
    `query IssueTeam($id: ID!) { issue(id: $id) { team { id } } }`,
    { id: issueId },
  );
  const teamId = issue.issue?.team?.id;
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
