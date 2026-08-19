# Summary

<!-- What does this PR change, and why? Reference the issue it closes (e.g. "Closes #N"). -->

Closes #

# Draft-first contribution sequence

This repository skips pull-request CI while a PR is a draft. The recommended
workflow is:

1. **Open as draft.** A draft PR (opened or updated with new commits) does not
   start CI jobs — `build-and-test` is guarded by
   `if: github.event.pull_request.draft == false`, so no runners are consumed
   while the work is still in progress.
2. **Iterate freely.** Pushing additional commits to a draft PR keeps CI
   silent. Use this phase for self-review, WIP commits, and local runs
   (`pnpm build && pnpm lint && pnpm test`).
3. **Mark "Ready for review".** The workflow subscribes to the
   `ready_for_review` event, so CI starts at this moment with the exact commit
   you already pushed — no empty "trigger CI" commit is needed.
4. **After ready.** Every subsequent push to a ready PR (the `synchronize`
   event) runs CI as usual.

Pushes to `main` run CI unchanged and are unaffected by the draft guard.

# Checklist

- [ ] Local checks pass: `pnpm build`, `pnpm lint`, `pnpm run build:skill -- --check`, `pnpm test`
- [ ] No network access required by tests
- [ ] PR is opened as **ready** (not draft) when it should be reviewed — CI only runs on non-draft PRs
