import type { LinearContext } from '../context.js';
import { requireKey } from '../config.js';
import { assertKnownFlags, takeFlag } from '../args.js';
import { AxiError } from '../errors.js';
import { fetchCycles } from '../linear.js';
import {
  field,
  pluck,
  custom,
  renderList,
  renderHelp,
  renderOutput,
  type FieldDef,
} from '../toon.js';
import { formatCountLine } from '../format.js';

export const CYCLES_HELP = `usage: linear-axi cycles [--team <KEY>]
	List recent cycles with their date range and progress, most recently updated first.

flags:
  --team <KEY>  restrict to one team (e.g. LIN); without it, cycles across all teams are listed, each tagged with its team key

columns:
  number   cycle number (unique within its team)
  team     team key (only shown without --team)
  status   past, active, or upcoming — derived from the date range
  range    cycle start..end as YYYY-MM-DD..YYYY-MM-DD
  progress percent complete, 0-100

examples:
  linear-axi cycles
  linear-axi cycles --team LIN
  linear-axi issues --cycle current --team LIN
`;

/** Field order: number, [team], status, range, progress. */
function listSchema(withTeam: boolean): FieldDef[] {
  return [
    field('number'),
    ...(withTeam ? [pluck('team', 'key', 'team')] : []),
    custom('status', (item: any) => cycleStatus(item)),
    custom('range', (item: any) => cycleRange(item)),
    custom('progress', (item: any) => Math.round((item.progress ?? 0) * 100)),
  ];
}

/**
 * Cycle status from its date range. upcoming = starts in the future;
 * past = ended; active = in between. (Linear's Cycle.isActive also excludes
 * manually early-completed cycles, which the dates alone cannot see — close
 * enough for a listing, and no extra field is fetched.)
 */
function cycleStatus(item: any): string {
  const now = Date.now();
  const start = new Date(item.startsAt).getTime();
  const end = new Date(item.endsAt).getTime();
  if (!isNaN(start) && now < start) return 'upcoming';
  if (!isNaN(end) && now >= end) return 'past';
  return 'active';
}

/** Date range as YYYY-MM-DD..YYYY-MM-DD (DateTime date part). */
function cycleRange(item: any): string {
  const start = String(item.startsAt ?? '').slice(0, 10) || 'unknown';
  const end = String(item.endsAt ?? '').slice(0, 10) || 'unknown';
  return `${start}..${end}`;
}

export async function cyclesCommand(
  args: string[],
  ctx: LinearContext,
): Promise<string> {
  assertKnownFlags(args, ['--team']);
  const apiKey = requireKey(ctx.apiKey);

  // A missing/blank --team must fail loud, not fall back to all-teams.
  const hasTeam = args.some((a) => a === '--team' || a.startsWith('--team='));
  const team = takeFlag(args, '--team');
  if (hasTeam && (team === undefined || team.trim() === '')) {
    throw new AxiError('--team requires a value', 'VALIDATION_ERROR', [
      'e.g. --team LIN',
    ]);
  }

  if (args.some((a) => !a.startsWith('--') && a !== '')) {
    const stray = args.filter((a) => !a.startsWith('--'));
    throw new AxiError(`Unexpected argument: ${stray[0]}`, 'VALIDATION_ERROR', [
      '`cycles` takes only --team — run `linear-axi cycles --help`',
    ]);
  }

  const { cycles, hasMore } = await fetchCycles(apiKey, team);

  const blocks: string[] = [];
  blocks.push(formatCountLine({ count: cycles.length, hasMore }));

  if (cycles.length) {
    blocks.push(renderList('cycles', cycles, listSchema(team === undefined)));
  } else {
    blocks.push('cycles: 0 found');
  }

  const hints: string[] = [];
  if (cycles.length) {
    const key = team ?? cycles[0]?.team?.key ?? '<KEY>';
    hints.push(
      `Run \`linear-axi issues --cycle current --team ${key}\` to list the active cycle's issues`,
    );
  } else if (team) {
    hints.push(
      `Team ${team} has no cycles — cycles may be disabled for it in Linear's team settings`,
    );
  } else {
    hints.push(
      "No cycles in this workspace yet — enable cycles for a team in Linear's team settings",
    );
  }
  blocks.push(renderHelp(hints));

  return renderOutput(blocks);
}
