import type { LinearContext } from '../context.js';
import { requireKey } from '../config.js';
import { fetchIssues, fetchViewer } from '../linear.js';
import {
  field,
  custom,
  renderList,
  renderHelp,
  renderOutput,
  type FieldDef,
} from '../toon.js';

// state is a nested { name, type } object — flatten to its lowercased name.
const issueSchema: FieldDef[] = [
  field('identifier'),
  field('title'),
  custom('state', (item) => item.state?.name?.toLowerCase() ?? ''),
];

export async function homeCommand(
  _args: string[],
  ctx: LinearContext,
): Promise<string> {
  const apiKey = requireKey(ctx.apiKey);

  const [viewer, assigned] = await Promise.all([
    fetchViewer(apiKey).catch(() => null),
    fetchIssues(apiKey, { assigneeIsMe: true, stateType: 'started' }, 5).catch(
      () => ({ issues: [], totalCount: 0 }),
    ),
  ]);

  const blocks: string[] = [];

  if (viewer) {
    blocks.push(`viewer: ${viewer.name} <${viewer.email}>`);
  }

  const started = assigned.issues;
  blocks.push(
    started.length
      ? renderList('my_started_issues', started, issueSchema)
      : 'my_started_issues: 0',
  );

  const hints: string[] = [];
  if (assigned.totalCount > started.length) {
    hints.push(
      `Run \`linear-axi issues --assignee me\` for all ${assigned.totalCount} assigned`,
    );
  }
  hints.push('Run `linear-axi issues` to list recent issues');
  hints.push('Run `linear-axi issue view <IDENTIFIER>` for details');
  blocks.push(renderHelp(hints));

  return renderOutput(blocks);
}
