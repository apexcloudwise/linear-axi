import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(
  resolve(repoRoot, '.github/workflows/ci.yml'),
  'utf8',
);
const lines = workflow.split('\n');

/**
 * Extract the block of a top-level (2-space-indented) mapping key together
 * with its direct children (4-space-indented lines). This keeps the
 * assertions below structural without needing a YAML parser dependency.
 */
function blockOf(key: string): string[] {
  const start = lines.indexOf(`  ${key}:`);
  expect(start, `expected a top-level "${key}:" entry`).toBeGreaterThanOrEqual(
    0,
  );
  const block = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (line !== '' && !line.startsWith('    ')) break;
    block.push(line);
  }
  while (block[block.length - 1] === '') block.pop();
  return block;
}

/**
 * Regression coverage for skipping pull-request CI while a PR is draft
 * (issue #4).
 *
 * Deliberately asserted as exact text:
 * - the draft guard must be `github.event.pull_request.draft == false`
 *   (loose equality). On `push` events `github.event.pull_request` is null,
 *   and GitHub casts null -> 0 and false -> 0 for `==`, so the job still
 *   runs on pushes to main. A stricter comparison would silently skip
 *   main-push CI.
 * - `packed-tarball` must NOT override its implicit `if: success()` gate
 *   with `if: always()` / `failure()` / `cancelled()`. With plain `needs:`,
 *   a job whose dependency was skipped is itself skipped, so the draft
 *   guard on `build-and-test` transitively skips `packed-tarball` too.
 */
describe('.github/workflows/ci.yml draft-PR CI gating', () => {
  it('subscribes pull_request to ready_for_review (plus opened/synchronize/reopened)', () => {
    expect(blockOf('pull_request')).toEqual([
      '  pull_request:',
      '    branches: [main]',
      '    types: [opened, synchronize, reopened, ready_for_review]',
    ]);
  });

  it('guards build-and-test so draft PRs do not start CI', () => {
    const job = blockOf('build-and-test');
    expect(job).toContain('    if: github.event.pull_request.draft == false');
    expect(
      job.indexOf('    if: github.event.pull_request.draft == false'),
    ).toBe(1);
  });

  it('keeps push CI on main unchanged', () => {
    expect(blockOf('push')).toEqual(['  push:', '    branches: [main]']);
  });

  it('packed-tarball is transitively skipped via needs, with no always() escape hatch', () => {
    expect(blockOf('packed-tarball')).toContain('    needs: build-and-test');
    expect(workflow).not.toMatch(/if: (always|failure|cancelled)\(\)/);
  });
});
