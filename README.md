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

**3. First publish (manual, bootstrap only)**

From a clean checkout of `main`, publish `0.1.0` manually:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run build:skill
npm publish --access public
```

This creates the package on npm. 2FA will be required. This is a one-time bootstrap step — the manual publish won't carry provenance. Final acceptance occurs after the first CI-driven release (e.g. #12 proposes `0.1.1`) carries provenance.

**4. Bind npm trusted publishing**

On https://www.npmjs.com, navigate to the `@apexcloudwise/linear-axi` package, then *Publishing access → Link a GitHub repository*:

- **Organization or user:** `apexcloudwise`
- **Repository:** `linear-axi`
- **Workflow filename:** `release-please.yml`
- **Environment:** `release`
- **Allowed actions:** `npm publish`

**5. Require 2FA and disallow tokens; revoke legacy tokens**

Under *Publishing access* for the package, select **Require two-factor authentication and disallow tokens** and save. Trusted publishers (OIDC) continue to work under this setting. Then, under *Access tokens*, remove any legacy automation tokens with publish access for the `@apexcloudwise` scope. All subsequent publishes must go through trusted publishing only.

**6. Verify**

After the next release PR is merged (see Releasing), run:

```sh
VERSION=$(npm view @apexcloudwise/linear-axi version)
PREFIX=$(mktemp -d)
npm install --prefix "$PREFIX" "@apexcloudwise/linear-axi@$VERSION"
INSTALLED_VERSION=$("$PREFIX/node_modules/.bin/linear-axi" --version)
test "$INSTALLED_VERSION" = "$VERSION"
npm access get status @apexcloudwise/linear-axi
```

Confirm `npm access` reports `public` and that the package page on npm shows a provenance badge linked to this repository. Subsequent releases are automated via the workflow.

**7. Record evidence and close #5**

Comment on issue #5 with: the published version, the release workflow run URL, the provenance link, the clean-install and version-assertion result, and public visibility status. Evidence must be sanitized — no credentials, OTPs, tokens, or reusable authentication material. #5 (and epic #1) close only after this evidence exists.

## License

MIT © ApexCloudWise
