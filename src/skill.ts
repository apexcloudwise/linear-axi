import { DESCRIPTION, TOP_HELP } from './cli.js';

// Trigger string agents match against to auto-load the skill. Terse and
// outcome-focused so it fires on "needs Linear" intents.
export const SKILL_DESCRIPTION =
  'Operate Linear (linear.app) through the linear-axi CLI - list and view issues, ' +
  'create, update, and delete issues, post comments and read comment threads, list teams, list/filter projects, list cycles, and list labels. ' +
  'Use whenever a task touches Linear: triaging or filing issues, changing issue state, setting priority, assigning issues or managing their labels, ' +
  'commenting on or reading an issue discussion via `comment list`, discovering team keys via `teams`, scoping work to a project via `projects` ' +
  'and `issues --project`, to a cycle via `cycles` and `issues --cycle`, assigning issues to a project or cycle with `issue create/update ' +
  '--project <name>` and `--cycle current|<number>`, or finding label names via `labels` for `issue create --label`, ' +
  '`issue update --label`, and `issues --label`.';

export const SKILL_AUTHOR = 'ApexCloudWise';

export const HERMES_TAGS = ['linear', 'issues', 'project-management', 'tasks'];
export const HERMES_CATEGORY = 'productivity';

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value);
}

/** Extract the `commands[N]:` block from TOP_HELP so the skill can't drift. */
export function extractCommandsBlock(): string {
  const match = TOP_HELP.match(/^(commands\[\d+\]:\n(?: {2}.*\n)+)/m);
  if (!match) {
    throw new Error('Could not find commands block in TOP_HELP');
  }
  return match[1].trimEnd();
}

/** Render the installable SKILL.md, generated from the same guidance the CLI prints. */
export function createSkillMarkdown(): string {
  return `---
name: linear-axi
description: ${yamlDoubleQuote(SKILL_DESCRIPTION)}
user-invocable: false
author: ${SKILL_AUTHOR}
metadata:
  hermes:
    tags: [${HERMES_TAGS.join(', ')}]
    category: ${HERMES_CATEGORY}
---

# linear-axi

${DESCRIPTION}

You do not need linear-axi installed globally - invoke it with \`npx -y @apexcloudwise/linear-axi <command>\`.
If linear-axi output shows a follow-up command starting with \`linear-axi\`, run it as \`npx -y @apexcloudwise/linear-axi ...\` instead.

linear-axi authenticates with a Linear personal API key (https://linear.app/settings/api). Provide it as \`LINEAR_API_KEY\`, pass \`--key <key>\` after the command, or save it with \`linear-axi login <key>\`. If a command fails with an auth error, ask the user to create a key and run \`linear-axi login\`.

## When to use

Use linear-axi whenever a task touches Linear: listing, viewing, filing, editing, or deleting issues; changing issue state, priority, assignee, or labels; commenting on issues or reading their comment threads; discovering team keys; listing projects and scoping issues to one with \`issues --project <name>\`; listing a team's cycles and scoping issues to one with \`issues --cycle current|<number> --team <KEY>\`; putting issues in a project or cycle with \`issue create/update --project <name>\` or \`--cycle current|<number>\`; or listing the workspace's labels and using their names with \`issues --label <name>\`, \`issue create --label <name>\`, or \`issue update --label <name>\`.

## Workflow

1. Run \`npx -y @apexcloudwise/linear-axi\` with no arguments for a dashboard - the current viewer and your started, assigned issues.
2. Drill in command-first: \`issues\`, \`issue view <IDENTIFIER>\`, \`teams\`, \`projects\`, \`cycles\`, \`labels\`.
3. Identify issues by Linear identifier (e.g. \`LIN-123\`) or UUID.
4. Create an issue with \`issue create --title "..." --team <KEY>\`; team keys come from \`teams\`, and \`--project "<name>"\` / \`--cycle current|<number>\` land it in a project or cycle straight away.
5. Change state with \`issue update <IDENTIFIER> --state "<name>"\`; pass the workflow state name exactly (e.g. \`"In Progress"\`). Assign with \`--assignee <name|me>\`, manage labels with \`--label <name>\` / \`--remove-label <name>\` (repeatable), and move it into a project or cycle with \`--project "<name>"\` / \`--cycle current|<number>\` in the same command.
6. Comment with \`comment <IDENTIFIER> --body "..."\` or \`--body-file <path>\` for multi-line bodies; read an issue's thread with \`comment list <IDENTIFIER>\` (newest first, \`--full\` for untruncated bodies).
7. Every response ends with contextual next-step hints under \`help:\` - follow them.

## Commands

\`\`\`
${extractCommandsBlock()}
\`\`\`

Installed copies also inherit the SDK built-in \`update\` command.
Run \`linear-axi update --check\` to compare the installed version with npm, or \`linear-axi update\` to upgrade.
When using \`npx -y @apexcloudwise/linear-axi\`, npx already resolves the package on demand.

Run \`npx -y @apexcloudwise/linear-axi --help\` for global flags, or \`npx -y @apexcloudwise/linear-axi <command> --help\` for per-command usage.

## Tips

- Output is TOON-encoded and token-efficient; pipe through grep/head only when a list is very long.
- Mutations are idempotent: updating an issue to its current state, or deleting an already-deleted issue, is a reported no-op (exit 0).
- Repeated \`--label\` flags match issues carrying ANY of the given labels; a missing or blank value is rejected, never dropped. Label names come from \`labels\`.
- \`issue update --label <name>\` adds to an issue's existing labels and \`--remove-label <name>\` removes one; the last removal sends an explicit empty set, so it works too. Re-assigning the current assignee (or a label set that already matches) is a reported no-op.
- \`issue create/update --project <name>\` matches the project name exactly (\`projects\` lists them) and fails loud on a miss; re-requesting the issue's current project or cycle is a reported no-op. On \`--cycle\`, "current" resolves the active cycle (scoped to \`--team\`'s when given; on update without \`--team\`, the workspace's single active one - ambiguous if several teams have one) while a cycle number always requires \`--team\` because numbers restart per team (\`cycles\` lists them).
- \`issues --cycle current\` lists every team's active-cycle issues (add \`--team <KEY>\` to narrow); \`--cycle <number>\` also requires \`--team\` because cycle numbers restart per team - find them with \`cycles [--team <KEY>]\`.
- \`issues --fields <a,b,c>\` and \`issue view <IDENTIFIER> --fields <a,b,c>\` add opt-in extra fields (per-command sets - see each command's --help) when the default columns lack something you need.
- \`issue view\` truncates the description by default; pass \`--full\` to see it entirely. \`comment list\` likewise previews each comment body; \`--full\` shows them whole.
- Issue references accept either a UUID or a \`TEAM-NUMBER\` identifier like \`LIN-123\`.
`;
}
