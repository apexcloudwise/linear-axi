import { AxiError } from './errors.js';

function flagEqualsPrefix(flag: string): string {
  return `${flag}=`;
}

/** Get a flag's value from --flag value or --flag=value without modifying args. */
export function getFlag(args: string[], name: string): string | undefined {
  const equalsPrefix = flagEqualsPrefix(name);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) {
      if (i + 1 >= args.length) return undefined;
      return args[i + 1];
    }
    if (arg.startsWith(equalsPrefix)) {
      return arg.slice(equalsPrefix.length);
    }
  }
  return undefined;
}

/** Get a flag's value from --flag value or --flag=value and remove it from args. */
export function takeFlag(args: string[], flag: string): string | undefined {
  const equalsPrefix = flagEqualsPrefix(flag);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag) {
      const val = args[i + 1];
      args.splice(i, 2);
      return val;
    }
    if (arg.startsWith(equalsPrefix)) {
      const val = arg.slice(equalsPrefix.length);
      args.splice(i, 1);
      return val;
    }
  }
  return undefined;
}

/** Check if a boolean flag is present. */
export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** Check if a boolean flag is present and remove it from args. */
export function takeBoolFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

function requireFlagValue(value: string, flag: string): string {
  if (value.trim() === '')
    throw new AxiError(`${flag} requires a value`, 'VALIDATION_ERROR');
  return value;
}

function collectAllFlags(
  args: string[],
  flag: string,
  consume: boolean,
): string[] {
  const result: string[] = [];
  const equalsPrefix = flagEqualsPrefix(flag);
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === flag) {
      result.push(requireFlagValue(args[i + 1] ?? '', flag));
      if (consume) args.splice(i, 2);
      else i += 2;
    } else if (arg.startsWith(equalsPrefix)) {
      result.push(requireFlagValue(arg.slice(equalsPrefix.length), flag));
      if (consume) args.splice(i, 1);
      else i++;
    } else {
      i++;
    }
  }
  return result;
}

/** Collect all values for a repeatable flag without modifying args. */
export function getAllFlags(args: string[], flag: string): string[] {
  return collectAllFlags(args, flag, false);
}

/** Like getAllFlags, but also removes every occurrence from args. */
export function takeAllFlags(args: string[], flag: string): string[] {
  return collectAllFlags(args, flag, true);
}

/** Get the first positional arg (non-flag) starting from startIndex. */
export function getPositional(
  args: string[],
  startIndex = 0,
): string | undefined {
  for (let i = startIndex; i < args.length; i++) {
    if (!args[i].startsWith('--')) return args[i];
  }
  return undefined;
}

/**
 * Reject any unrecognized flags in args against an allow-set. AXI principle 6:
 * fail loud (exit 2) on unknown flags rather than silently dropping them.
 * `--help` and `--key`/`--json` globals are handled upstream, not here.
 *
 * Returns the args unchanged when all flags are known; throws AxiError otherwise.
 */
export function assertKnownFlags(
  args: string[],
  known: string[],
): void {
  const knownSet = new Set(known);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    // Strip =value form
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (knownSet.has(name)) {
      // Skip the value of a space-form flag only if it takes a value; we
      // accept both forms and the value position is handled by takeFlag later,
      // so do not consume next token here.
      continue;
    }
    throw new AxiError(
      `unknown flag ${name}`,
      'VALIDATION_ERROR',
      [`valid flags: ${known.join(', ')} (--help always allowed)`],
    );
  }
}
