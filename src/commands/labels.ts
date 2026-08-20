import type { LinearContext } from '../context.js';
import { requireKey } from '../config.js';
import { assertKnownFlags } from '../args.js';
import { fetchLabels } from '../linear.js';
import { field, renderList, renderHelp, renderOutput } from '../toon.js';
import { formatCountLine } from '../format.js';

export const LABELS_HELP = `usage: linear-axi labels
	List the issue labels in your Linear workspace, most recently updated first.

columns:
  name  label name (usable with issue create --label and issues --label)
  color label color as a raw HEX string (e.g. #EB5757)

examples:
  linear-axi labels
  linear-axi issues --label bug
  linear-axi issue create --title "Fix login" --team ENG --label bug
`;

const listSchema = [field('name'), field('color')];

export async function labelsCommand(
  args: string[],
  ctx: LinearContext,
): Promise<string> {
  // `labels` takes no flags — reject any rather than silently dropping it.
  assertKnownFlags(args, []);
  const apiKey = requireKey(ctx.apiKey);
  const { labels, hasMore } = await fetchLabels(apiKey);

  const blocks: string[] = [];
  blocks.push(formatCountLine({ count: labels.length, hasMore }));

  if (labels.length) {
    blocks.push(renderList('labels', labels, listSchema));
  } else {
    blocks.push('labels: 0 found');
  }

  const hints: string[] = [];
  if (labels.length) {
    hints.push(
      'Run `linear-axi issues --label "<name>"` to list issues carrying a label',
    );
    hints.push(
      'Run `linear-axi issue create --label <name>` to add a label to a new issue',
    );
  } else {
    hints.push(
      'Create a label in the Linear app (workspace or team settings) — none exist in this workspace yet',
    );
  }
  blocks.push(renderHelp(hints));

  return renderOutput(blocks);
}
