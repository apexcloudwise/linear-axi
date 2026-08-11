import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, chmodSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveGlobalFlags, parseIssueRef, saveApiKeyToPath } from '../src/config.js';

describe('resolveGlobalFlags', () => {
  it('strips --key in space form and resolves the key', () => {
    const g = resolveGlobalFlags(
      ['issues', '--key', 'lin_api_x', '--team', 'LIN'],
      {},
    );
    expect(g.apiKey).toBe('lin_api_x');
    expect(g.args).toEqual(['issues', '--team', 'LIN']);
  });

  it('strips --key= in equals form', () => {
    const g = resolveGlobalFlags(['--key=lin_api_x', 'issues'], {});
    expect(g.apiKey).toBe('lin_api_x');
    expect(g.args).toEqual(['issues']);
  });

  it('prefers the flag over env and config', () => {
    const g = resolveGlobalFlags(
      ['--key', 'flag-key'],
      { LINEAR_API_KEY: 'env-key' },
    );
    expect(g.apiKey).toBe('flag-key');
  });

  it('falls back to LINEAR_API_KEY env', () => {
    const g = resolveGlobalFlags(['issues'], { LINEAR_API_KEY: 'env-key' });
    expect(g.apiKey).toBe('env-key');
    expect(g.args).toEqual(['issues']);
  });

  it('returns undefined apiKey when nothing is resolvable', () => {
    const g = resolveGlobalFlags(['issues'], {});
    expect(g.apiKey).toBeUndefined();
  });
});

describe('parseIssueRef', () => {
  it('parses a UUID', () => {
    const ref = parseIssueRef('11111111-2222-3333-4444-555555555555');
    expect(ref).toEqual({
      kind: 'uuid',
      id: '11111111-2222-3333-4444-555555555555',
    });
  });

  it('parses an identifier', () => {
    const ref = parseIssueRef('LIN-123');
    expect(ref).toEqual({ kind: 'identifier', team: 'LIN', number: 123 });
  });

  it('uppercases the team key', () => {
    expect(parseIssueRef('eng-9')).toEqual({
      kind: 'identifier',
      team: 'ENG',
      number: 9,
    });
  });

  it('rejects garbage', () => {
    expect(() => parseIssueRef('not-a-ref')).toThrow();
  });
});

describe('saveApiKey file permissions', () => {
  let tmpHome: string;
  let tmpConfigDir: string;
  let tmpConfigPath: string;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `linear-axi-perm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tmpConfigDir = join(tmpHome, '.config', 'linear-axi');
    tmpConfigPath = join(tmpConfigDir, 'config.json');
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('creates a new config file with mode 0600 regardless of umask', () => {
    mkdirSync(tmpConfigDir, { recursive: true });
    saveApiKeyToPath(tmpConfigPath, 'lin_api_testkey');

    const mode = statSync(tmpConfigPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('repairs an existing config file from 0644 to 0600 on re-save', () => {
    mkdirSync(tmpConfigDir, { recursive: true });
    writeFileSync(tmpConfigPath, JSON.stringify({ apiKey: 'old-key' }, null, 2) + '\n');
    chmodSync(tmpConfigPath, 0o644);

    saveApiKeyToPath(tmpConfigPath, 'lin_api_newkey');

    const mode = statSync(tmpConfigPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('does not leak token values in assertions', () => {
    mkdirSync(tmpConfigDir, { recursive: true });
    saveApiKeyToPath(tmpConfigPath, 'lin_api_s3cret_t0ken');

    const exists = existsSync(tmpConfigPath);
    expect(exists).toBe(true);
  });
});
