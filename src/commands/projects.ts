import type { LinearContext } from '../context.js';
import { requireKey } from '../config.js';
import { assertKnownFlags } from '../args.js';
import { fetchProjects } from '../linear.js';
import {
  field,
  custom,
  renderList,
  renderHelp,
  renderOutput,
  type FieldDef,
} from '../toon.js';
import { formatCountLine } from '../format.js';

export const PROJECTS_HELP = `usage: linear-axi projects
	List the projects in your Linear workspace, most recently updated first.

columns:
  name     project name
  state    lifecycle state: backlog, planned, started, paused, completed, canceled
  progress percent complete, 0-100
  lead     project lead (none if unassigned)
  target   target date as YYYY-MM-DD (none if unset)

examples:
  linear-axi projects
  linear-axi issues --project "Mobile app" --state started
`;

const listSchema: FieldDef[] = [
  field('name'),
  // status.type is the raw lowercase lifecycle value (planned, started, ...);
  // Project.state is deprecated in favor of Project.status (see linear.ts).
  custom('state', (item: any) => item.status?.type ?? ''),
  custom('progress', (item: any) => Math.round((item.progress ?? 0) * 100)),
  custom('lead', (item: any) => item.lead?.name ?? 'none'),
  custom('target', (item: any) => item.targetDate ?? 'none'),
];

export async function projectsCommand(
  args: string[],
  ctx: LinearContext,
): Promise<string> {
  // `projects` takes no flags — reject any rather than silently dropping it.
  assertKnownFlags(args, []);
  const apiKey = requireKey(ctx.apiKey);
  const { projects, hasMore } = await fetchProjects(apiKey);

  const blocks: string[] = [];
  blocks.push(formatCountLine({ count: projects.length, hasMore }));

  if (projects.length) {
    blocks.push(renderList('projects', projects, listSchema));
  } else {
    blocks.push('projects: 0 found');
  }

  const hints: string[] = [];
  if (projects.length) {
    hints.push(
      'Run `linear-axi issues --project "<name>"` to list a project\'s issues',
    );
  } else {
    hints.push(
      'Create a project in the Linear app — none exist in this workspace yet',
    );
  }
  blocks.push(renderHelp(hints));

  return renderOutput(blocks);
}
