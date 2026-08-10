# linear-axi

[![npm](https://img.shields.io/npm/v/@apexcloudwise/linear-axi?style=flat-square)](https://www.npmjs.com/package/@apexcloudwise/linear-axi)

An [AXI](https://github.com/kunchenguid/axi)-compliant CLI for [Linear](https://linear.app). Agent-ergonomic, token-efficient TOON output, structured errors, idempotent mutations — built on [`axi-sdk-js`](https://github.com/kunchenguid/axi/tree/main/packages/axi-sdk-js).

Higher accuracy with lower token cost than calling the Linear GraphQL API or an MCP server directly.

## Install

```sh
npm install -g @apexcloudwise/linear-axi
```

Or run on demand without a global install:

```sh
npx -y @apexcloudwise/linear-axi <command>
```

Then add to your `CLAUDE.md` / `AGENTS.md`:

```
Use `linear-axi` for Linear issue operations.
```

## Authenticate

Create a personal API key at https://linear.app/settings/api, then either:

```sh
export LINEAR_API_KEY=lin_api_xxx
# or
linear-axi login lin_api_xxx
# or pass it per command
linear-axi issues --key lin_api_xxx
```

## Commands

```
linear-axi                      # dashboard: viewer + your started issues
linear-axi issues               # list issues (filters: --team --state --assignee --label --search --limit)
linear-axi issue view LIN-123   # issue details (--full disables truncation)
linear-axi issue create --title "..." --team ENG --label bug
linear-axi issue update LIN-123 --state "In Progress" --priority 2
linear-axi issue delete LIN-123
linear-axi comment LIN-123 --body "..."   # or --body-file <path>
linear-axi teams                # list team keys
linear-axi login <key>          # save API key to config
linear-axi setup hooks          # install agent SessionStart hooks
linear-axi update               # self-update (SDK built-in)
```

Run `linear-axi --help` or `linear-axi <command> --help` for full reference.

## Ambient context

`linear-axi setup hooks` installs a `SessionStart` hook for Claude Code, Codex, and OpenCode so every session starts with a compact dashboard (your started, assigned issues) — no invocation needed.

An installable Agent Skill is also shipped at `skills/linear-axi/SKILL.md`, generated from the CLI's own guidance so it never drifts. A CI `--check` step fails if the committed skill is stale.

## AXI principles

This CLI follows the [10 AXI design principles](https://github.com/kunchenguid/axi#the-10-principles): TOON output (~40% smaller than JSON), minimal default schemas, truncated detail with a `--full` escape hatch, pre-computed counts, definitive empty states, structured errors on stdout, no interactive prompts, fail-loud on unknown flags, content-first home view, contextual next-step hints, and a dependency-free `--version` fast path.

## Development

```sh
pnpm install
pnpm run build          # tsc -> dist/
pnpm run build:skill    # regenerate skills/linear-axi/SKILL.md
pnpm test               # vitest
pnpm run lint
```

## License

MIT © ApexCloudWise
