import type { LinearContext } from '../context.js';
import { requireKey } from '../config.js';
import { fetchTeams } from '../linear.js';
import { renderList, renderHelp, renderOutput, field } from '../toon.js';

export const TEAMS_HELP = `usage: linear-axi teams
List the teams in your Linear workspace with their keys.

examples:
  linear-axi teams
`;

export async function teamsCommand(
  _args: string[],
  ctx: LinearContext,
): Promise<string> {
  const apiKey = requireKey(ctx.apiKey);
  const teams = await fetchTeams(apiKey);

  const blocks: string[] = [];
  if (teams.length) {
    blocks.push(renderList('teams', teams, [field('key'), field('name')]));
  } else {
    blocks.push('teams: 0 found');
  }

  blocks.push(
    renderHelp([
      'Use a team key with `issue create --team <KEY>`',
    ]),
  );

  return renderOutput(blocks);
}
