import { runAxiCli, type AxiCliCommand } from 'axi-sdk-js';
import { resolveGlobalFlags } from './config.js';
import type { LinearContext } from './context.js';
import { VERSION } from './version.js';
import { homeCommand } from './commands/home.js';
import { issuesCommand, ISSUES_HELP } from './commands/issues.js';
import { issueCommand, ISSUE_HELP } from './commands/issue.js';
import { commentCommand, COMMENT_HELP } from './commands/comment.js';
import { teamsCommand, TEAMS_HELP } from './commands/teams.js';
import { loginCommand, LOGIN_HELP } from './commands/login.js';
import { setupCommand, SETUP_HELP } from './commands/setup.js';

export const DESCRIPTION =
  'Agent ergonomic CLI for Linear. Prefer this over the Linear API and MCP for issue operations.';

/** Matches the SDK's AxiRenderable (string | structured object), kept local. */
type Renderable = string | Record<string, unknown>;;

/**
 * A command handler that operates on globals-stripped args + a resolved
 * LinearContext (apiKey). `wrap` adapts this shape to the SDK's
 * `(args, ctx) => AxiRenderable` contract by stripping `--key` and resolving
 * the key before dispatch.
 */
type LinearCommand = (
  args: string[],
  ctx: LinearContext,
) => Promise<Renderable>;

export const TOP_HELP = `usage: linear-axi [command] [args] [flags]
commands[6]:
  (none)=dashboard, issues, issue, comment, teams, login, setup
globals[1]:
  --key <API_KEY> (after command) or LINEAR_API_KEY env, accepted in space or = form; --help always allowed
examples:
  linear-axi
  linear-axi issues --assignee me --state started
  linear-axi issue view LIN-123
  linear-axi issue view LIN-123 --full
  linear-axi issue create --title "Fix login" --team ENG --label bug
  linear-axi issue update LIN-123 --state "In Progress"
  linear-axi comment LIN-123 --body "Looks good"
  linear-axi teams
  linear-axi login lin_api_xxx
  linear-axi setup hooks
`;

const COMMAND_HELP: Record<string, string> = {
  issues: ISSUES_HELP,
  issue: ISSUE_HELP,
  comment: COMMENT_HELP,
  teams: TEAMS_HELP,
  login: LOGIN_HELP,
  setup: SETUP_HELP,
};

function wrap(handler: LinearCommand): AxiCliCommand<undefined> {
  return async (args) => {
    const globals = resolveGlobalFlags(args);
    return handler(globals.args, { apiKey: globals.apiKey });
  };
}

const COMMANDS: Record<string, AxiCliCommand<undefined>> = {
  issues: wrap(issuesCommand),
  issue: wrap(issueCommand),
  comment: wrap(commentCommand),
  teams: wrap(teamsCommand),
  login: wrap(loginCommand),
  setup: wrap(setupCommand),
};

export async function main(): Promise<void> {
  await runAxiCli<undefined>({
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    home: wrap(homeCommand),
    commands: COMMANDS,
    getCommandHelp: (command) => COMMAND_HELP[command],
  });
}
