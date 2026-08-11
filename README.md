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
INSTALLED_VERSION=("$PREFIX/node_modules/.bin/linear-axi" --version)
test "$INSTALLED_VERSION" = "$VERSION"
npm access get status @apexcloudwise/linear-axi
```

Confirm `npm access` reports `public` and that the package page on npm shows a provenance badge linked to this repository. Subsequent releases are automated via the workflow.

**7. Record evidence and close #5**

Comment on issue #5 with: the published version, the release workflow run URL, the provenance link, the clean-install and version-assertion result, and public visibility status. Evidence must be sanitized — no credentials, OTPs, tokens, or reusable authentication material. #5 (and epic #1) close only after this evidence exists.
