import { AxiError, exitCodeForError } from 'axi-sdk-js';

export { AxiError, exitCodeForError };

export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'VALIDATION_ERROR'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'
  | 'CONFIG_ERROR'
  | 'UNKNOWN';

export interface LinearGraphQLError {
  message: string;
  path?: Array<string | number>;
  extensions?: {
    code?: string;
    userError?: boolean | string | null;
    [key: string]: unknown;
  };
}

export interface LinearQueryResult {
  status: number;
  body: unknown;
}

/**
 * Map a Linear GraphQL/HTTP failure into a structured AxiError. Linear returns
 * either an HTTP error status (401/403/429) or a 200 with a top-level `errors`
 * array. Either is translated into an actionable message + suggestion set, never
 * a raw stack trace.
 */
export function mapLinearError(result: LinearQueryResult): AxiError {
  const { status, body } = result;
  const gqlErrors = readGraphQLErrors(body);

  // HTTP-level status first (auth/forbidden/rate-limit are unambiguous).
  if (status === 401 || status === 403) {
    if (status === 401 || /forbidden|permission|scope/i.test(firstMessage(gqlErrors))) {
      return new AxiError(
        'Linear auth required — set LINEAR_API_KEY or pass --key <key>',
        'AUTH_REQUIRED',
        [
          'Create a personal API key at https://linear.app/settings/api',
          'Then export LINEAR_API_KEY=<key> or run commands with --key <key>',
        ],
      );
    }
    return new AxiError(
      'Insufficient Linear permissions for this action',
      'FORBIDDEN',
    );
  }

  if (
    status === 429 ||
    gqlErrors.some((error) => error.extensions?.code === 'RATELIMITED')
  ) {
    return new AxiError('Linear rate limit hit — wait and retry', 'RATE_LIMITED', [
      'Wait ~60s before retrying',
    ]);
  }

  if (status >= 500) {
    return new AxiError(
      `Linear returned HTTP ${status} — transient server error`,
      'NETWORK_ERROR',
      ['Retry in a few seconds'],
    );
  }

  // 200 with GraphQL errors, or a 4xx we did not special-case above.
  if (gqlErrors.length > 0) {
    const first = gqlErrors[0];
    // `extensions.userError` is a boolean flag on Linear errors, NOT the
    // message — use `message` as the human-readable text.
    const message = first.message;
    const path = first.path?.length ? ` (at ${first.path.join('.')})` : '';
    const code = first.extensions?.code ? ` [${first.extensions.code}]` : '';
    const text = `${message}${path}${code}`;

    if (/not found|entity not found/i.test(message)) {
      return new AxiError(text, 'NOT_FOUND');
    }
    if (/auth|unauthor/i.test(message)) {
      return new AxiError(text, 'AUTH_REQUIRED');
    }
    if (/validation|invalid|required|already/i.test(message)) {
      return new AxiError(text, 'VALIDATION_ERROR');
    }

    // Surface the full extensions as a hint so query-shape errors (e.g. an
    // invalid field or filter) are debuggable in one round trip.
    const extHint =
      first.extensions && Object.keys(first.extensions).length > 0
        ? `extensions: ${JSON.stringify(first.extensions)}`
        : undefined;
    return new AxiError(text, 'UNKNOWN', extHint ? [extHint] : []);
  }

  if (status === 404) {
    return new AxiError('Not found', 'NOT_FOUND');
  }

  return new AxiError(`Linear request failed (HTTP ${status})`, 'UNKNOWN');
}

export function networkError(cause: unknown): AxiError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new AxiError(
    `Could not reach Linear API: ${message}`,
    'NETWORK_ERROR',
    ['Check your network connection and retry'],
  );
}

export function missingKeyError(): AxiError {
  return new AxiError(
    'Linear API key not provided',
    'CONFIG_ERROR',
    [
      'Create a personal API key at https://linear.app/settings/api',
      'Export it as LINEAR_API_KEY, or pass --key <key> after the command',
      'Or run `linear-axi login <key>` to save it to config',
    ],
  );
}

function readGraphQLErrors(body: unknown): LinearGraphQLError[] {
  if (!body || typeof body !== 'object') return [];
  const errors = (body as { errors?: unknown }).errors;
  return Array.isArray(errors) ? (errors as LinearGraphQLError[]) : [];
}

function firstMessage(errors: LinearGraphQLError[]): string {
  // `extensions.userError` is a boolean flag, not the text — use `message`.
  return errors[0]?.message || '';
}
