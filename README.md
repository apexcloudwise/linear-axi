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

## Releasing

Releases are automated via [Release Please](https://github.com/googleapis/release-please-action). Pushing a conventional commit (e.g. `fix:`, `feat:`) to `main` opens or updates a release PR containing the version bump, CHANGELOG, and manifest.

**Prerequisite:** repo admin must enable *Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests*.

**To merge a release PR:**

1. On the release PR, click **Approve workflows to run** in the PR banner to allow CI.
2. Wait for `build-and-test` and `packed-tarball` jobs to pass.
3. Review the version bump and CHANGELOG entries.
4. Merge the release PR — the tag and GitHub release are created automatically.

## Publishing setup

Publishing is fully automated via trusted OIDC — no npm tokens are stored. A one-time owner bootstrap is required:

> **Important:** Do not merge any release PR (e.g. #12) before completing steps 1–5 below. The release-please workflow's `publish` job will fail until trusted publishing is bound.

**1. Enable 2FA on the npm account**

Log in at https://www.npmjs.com and enable two-factor authentication (auth-only or auth-and-writes).

**2. Create the `release` GitHub environment**

Go to *Settings → Environments → New environment*, name it `release`. Optionally add required reviewers for a human approval gate before publish.

**3. First publish (manual)**

From a clean checkout of `main`, publish `0.1.0` manually:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run build:skill
npm publish --access public
```

This creates the package on npm. 2FA will be required. This is a one-time step. The manual publish won't carry provenance — provenance begins with the first CI-driven publish via the release workflow (see step 6).

**4. Revoke traditional publishing tokens**

On https://www.npmjs.com, under *Access tokens*, ensure no automation tokens with publish access exist for the `@apexcloudwise` scope. Remove any legacy tokens. All subsequent publishes must go through trusted publishing (OIDC) only.

**5. Bind npm trusted publishing**

On https://www.npmjs.com, navigate to the `@apexcloudwise/linear-axi` package, then *Publishing access → Link a GitHub repository*:

- **Repository:** `apexcloudwise/linear-axi`
- **Workflow:** `release-please.yml`
- **Environment:** `release`
- **Allowed actions:** `npm publish`

**6. Verify**

After the next release PR is merged (see Releasing), confirm:

```sh
npm view @apexcloudwise/linear-axi version
```

Check that the package page on npm shows a provenance badge linked to this repository. Then verify a clean install:

```sh
mkdir /tmp/verify-install && npm install --prefix /tmp/verify-install @apexcloudwise/linear-axi
/tmp/verify-install/node_modules/.bin/linear-axi --version
```

Confirm the reported version matches the published version and that the package is publicly visible (`"access": "public"`). Subsequent releases are automated via the workflow. When recording #5 completion evidence (e.g. `npm view` output, install logs), ensure all evidence is sanitized — no tokens, secrets, or reusable authentication material.

## License

MIT © ApexCloudWise
