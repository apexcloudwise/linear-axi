import { saveApiKey } from '../config.js';
import { getPositional } from '../args.js';
import { AxiError } from '../errors.js';
import { renderOutput } from '../toon.js';
import { fetchViewer } from '../linear.js';
import type { LinearContext } from '../context.js';

export const LOGIN_HELP = `usage: linear-axi login <API_KEY>
Save a Linear personal API key to ~/.config/linear-axi/config.json and verify it.

Create a key at https://linear.app/settings/api.

examples:
  linear-axi login lin_api_xxx
`;

export async function loginCommand(
  args: string[],
  _ctx: LinearContext,
): Promise<string> {
  const key = getPositional(args);
  if (!key || !key.trim()) {
    throw new AxiError('Missing API key', 'VALIDATION_ERROR', [
      'linear-axi login <API_KEY>',
      'Create a key at https://linear.app/settings/api',
    ]);
  }

  // Verify the key before persisting it.
  const viewer = await fetchViewer(key.trim()).catch(() => null);
  if (!viewer) {
    throw new AxiError(
      'Key rejected by Linear — not saving',
      'AUTH_REQUIRED',
      ['Check the key at https://linear.app/settings/api'],
    );
  }

  saveApiKey(key.trim());

  return renderOutput([
    `login: saved key for ${viewer.name} <${viewer.email}>`,
    `config: ~/.config/linear-axi/config.json`,
  ]);
}
