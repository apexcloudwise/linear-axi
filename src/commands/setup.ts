import { AxiError, installSessionStartHooks } from 'axi-sdk-js';
import { renderHelp, renderOutput } from '../toon.js';
import type { LinearContext } from '../context.js';

export const SETUP_HELP = `usage: linear-axi setup hooks
Install or repair agent SessionStart hooks for linear-axi ambient context.

examples:
  linear-axi setup hooks
`;

export async function setupCommand(
  args: string[],
  _ctx: LinearContext,
): Promise<string> {
  if (args.length !== 1 || args[0] !== 'hooks') {
    throw new AxiError('Unknown setup action', 'VALIDATION_ERROR', [
      'Run `linear-axi setup hooks`',
    ]);
  }

  installSessionStartHooks({
    marker: 'linear-axi',
    binaryNames: ['linear-axi'],
  });

  return renderOutput([
    'hooks:\n  status: installed\n  integrations: Claude Code, Codex, OpenCode',
    renderHelp(['Restart your agent session to receive linear-axi ambient context']),
  ]);
}
