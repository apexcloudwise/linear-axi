import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, openSync, writeSync, closeSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { AxiError, missingKeyError } from './errors.js';

export const CONFIG_DIR = join(homedir(), '.config', 'linear-axi');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export interface LinearConfig {
  apiKey?: string;
}

export interface GlobalFlags {
  apiKey: string | undefined;
  args: string[];
}

/**
 * Strip the global flag (--key) from args and resolve the API key with
 * precedence: --key flag > LINEAR_API_KEY env > config file.
 *
 * Returns apiKey as undefined when no key is resolvable — commands that need
 * authentication call `requireKey()` to surface a structured error. This lets
 * key-free commands (`setup`, `login`) run before any key exists.
 *
 * Globals are stripped here (not in runAxiCli's resolveContext) because the SDK
 * passes the original argv to handlers; stripping in the wrapper guarantees
 * handlers never see `--key`, so their unknown-flag validation stays clean.
 */
export function resolveGlobalFlags(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): GlobalFlags {
  const { keyFlag, remaining } = stripGlobals(args);
  const apiKey = resolveApiKey(keyFlag, env);
  return { apiKey, args: remaining };
}

/** Throw a structured error when a command needs a key it does not have. */
export function requireKey(apiKey: string | undefined): string {
  if (apiKey && apiKey.trim() !== '') return apiKey;
  throw missingKeyError();
}

/** Persist a key to the config file (used by the `login` command). */
export function saveApiKey(key: string): void {
  saveApiKeyToPath(CONFIG_PATH, key);
}

export function saveApiKeyToPath(filePath: string, key: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const data = JSON.stringify({ apiKey: key }, null, 2) + '\n';
  if (existsSync(filePath)) {
    writeFileSync(filePath, data);
    chmodSync(filePath, 0o600);
  } else {
    const fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
  }
}

export function readConfig(): LinearConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as LinearConfig;
  } catch {
    return {};
  }
}

function resolveApiKey(
  flagValue: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (flagValue && flagValue.trim() !== '') return flagValue.trim();
  const envKey = env['LINEAR_API_KEY'];
  if (envKey && envKey.trim() !== '') return envKey.trim();
  const configKey = readConfig().apiKey;
  if (configKey && configKey.trim() !== '') return configKey.trim();
  return undefined;
}

function stripGlobals(args: string[]): {
  keyFlag: string | undefined;
  remaining: string[];
} {
  let keyFlag: string | undefined;
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--key' && i + 1 < args.length) {
      keyFlag = args[i + 1];
      i++;
      continue;
    }
    if (arg.startsWith('--key=')) {
      keyFlag = arg.slice('--key='.length);
      continue;
    }

    remaining.push(arg);
  }

  return { keyFlag, remaining };
}

/** Parse a Linear issue reference: UUID, or "TEAM-123" identifier. */
export function parseIssueRef(
  ref: string,
): { kind: 'uuid'; id: string } | { kind: 'identifier'; team: string; number: number } {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuid.test(ref)) return { kind: 'uuid', id: ref.toLowerCase() };

  const ident = /^([A-Za-z][A-Za-z0-9_]+)-(\d+)$/.exec(ref);
  if (ident) {
    return {
      kind: 'identifier',
      team: ident[1].toUpperCase(),
      number: parseInt(ident[2], 10),
    };
  }

  throw new AxiError(
    `Invalid issue reference: "${ref}"`,
    'VALIDATION_ERROR',
    [
      'Pass a UUID or a Linear identifier like "LIN-123"',
      'Run `linear-axi issues` to see identifiers',
    ],
  );
}
