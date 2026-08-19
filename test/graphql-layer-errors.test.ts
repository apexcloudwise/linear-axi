// mapLinearError END TO END through linearRequest (#29): every error branch
// is driven by a stubbed HTTP response — HTTP status codes AND GraphQL 200 +
// errors[] variants — and asserted as the structured AxiError (code, message,
// hints) the CLI actually surfaces. errors.test.ts unit-tests mapLinearError
// directly and rate-limit-retry.test.ts already covers through linearRequest:
// 401 (AUTH_REQUIRED), 429 (RATE_LIMITED, retried), 500 (NETWORK_ERROR), a
// generic GraphQL message, and a thrown fetch (networkError). This file fills
// the remaining matrix: 400, 403 (both sub-branches), 404, 502, GraphQL
// not-found/auth/validation messages, message formatting with path +
// extensions.code, the extensions hint, the non-JSON-body fallback, and the
// LINEAR_AXI_DEBUG dump.
//
// Fetch-stub pattern per test/rate-limit-retry.test.ts: vi.stubGlobal('fetch',
// ...) with Response-like { ok, status, headers, json } objects and
// afterEach(vi.unstubAllGlobals). No network access.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { linearRequest, LINEAR_API_URL } from '../src/linear.js';
import { AxiError } from '../src/errors.js';

const FAKE_KEY = 'lin_api_fake';
const QUERY = 'query { viewer { id name email } }';

/** A 200/data envelope (also used for 200 + errors[] payloads). */
function gqlResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => payload,
  } as Response;
}

/** An HTTP failure with the given JSON body. */
function httpError(status: number, payload: unknown = {}): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: async () => payload,
  } as Response;
}

/** A failure whose body is not JSON — linearRequest's json() catch branch. */
function nonJsonError(status: number): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  } as Response;
}

/**
 * Stub global fetch to answer with `responses` in order (last one repeats).
 * Returns the mock for call/argument assertions.
 */
function stubSequencedFetch(...responses: Response[]) {
  let call = 0;
  const fetchMock = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) => {
      const response = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return response;
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Run linearRequest against one error response; return the thrown AxiError. */
async function requestError(response: Response): Promise<AxiError> {
  stubSequencedFetch(response);
  return (await linearRequest(FAKE_KEY, QUERY).catch(
    (e: unknown) => e,
  )) as AxiError;
}

function expectAxiError(err: AxiError, code: string, message: string) {
  expect(err).toBeInstanceOf(AxiError);
  expect(err.code).toBe(code);
  expect(err.message).toBe(message);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('request shape', () => {
  it('POSTs the document to the Linear URL with the API key and variables', async () => {
    const fetchMock = stubSequencedFetch(
      gqlResponse({ data: { viewer: { id: 'u-1' } } }),
    );
    const variables = { id: 'LIN-1', first: 25 };

    await linearRequest(FAKE_KEY, QUERY, variables);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(LINEAR_API_URL);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: FAKE_KEY,
    });
    expect(init?.body).toBe(JSON.stringify({ query: QUERY, variables }));
  });

  it('defaults variables to an empty object when omitted', async () => {
    const fetchMock = stubSequencedFetch(
      gqlResponse({ data: { viewer: { id: 'u-1' } } }),
    );

    await linearRequest(FAKE_KEY, QUERY);

    expect(fetchMock.mock.calls[0]![1]?.body).toBe(
      JSON.stringify({ query: QUERY, variables: {} }),
    );
  });
});

describe('HTTP status matrix (no GraphQL errors)', () => {
  it('maps 400 to UNKNOWN with the status in the message', async () => {
    const err = await requestError(httpError(400, { errors: [] }));
    // errors: [] is an empty array — not GraphQL-level errors — so the plain
    // 4xx fallback fires.
    expectAxiError(err, 'UNKNOWN', 'Linear request failed (HTTP 400)');
  });

  it('maps 400 with an unparseable body via the null-body fallback', async () => {
    // The json() call throws -> body=null -> mapLinearError({status:400,
    // body:null}) — same UNKNOWN mapping, proving the catch branch.
    const err = await requestError(nonJsonError(400));
    expectAxiError(err, 'UNKNOWN', 'Linear request failed (HTTP 400)');
  });

  it('maps a message-less 403 to FORBIDDEN', async () => {
    const err = await requestError(httpError(403));
    expectAxiError(
      err,
      'FORBIDDEN',
      'Insufficient Linear permissions for this action',
    );
  });

  it('maps a 403 whose GraphQL message says forbidden to AUTH_REQUIRED', async () => {
    const err = await requestError(
      httpError(403, {
        errors: [{ message: 'Forbidden resource: scope missing' }],
      }),
    );
    // The forbidden-message branch overrides the generic 403 FORBIDDEN path.
    expectAxiError(
      err,
      'AUTH_REQUIRED',
      'Linear auth required — set LINEAR_API_KEY or pass --key <key>',
    );
    expect(err.suggestions?.join(' ')).toContain('linear.app/settings/api');
  });

  it('maps a plain 404 to NOT_FOUND', async () => {
    const err = await requestError(httpError(404));
    expectAxiError(err, 'NOT_FOUND', 'Not found');
  });

  it('maps 502 to NETWORK_ERROR like every 5xx', async () => {
    const err = await requestError(httpError(502));
    expectAxiError(
      err,
      'NETWORK_ERROR',
      'Linear returned HTTP 502 — transient server error',
    );
    expect(err.suggestions).toEqual(['Retry in a few seconds']);
  });
});

describe('GraphQL errors[] matrix (HTTP 200)', () => {
  it('maps a not-found message to NOT_FOUND with the message as text', async () => {
    const err = await requestError(
      gqlResponse({ errors: [{ message: 'Issue not found' }] }),
    );
    expectAxiError(err, 'NOT_FOUND', 'Issue not found');
  });

  it('maps an authorization message to AUTH_REQUIRED', async () => {
    const err = await requestError(
      gqlResponse({ errors: [{ message: 'User is unauthorized' }] }),
    );
    expectAxiError(err, 'AUTH_REQUIRED', 'User is unauthorized');
  });

  it('maps a validation message to VALIDATION_ERROR', async () => {
    const err = await requestError(
      gqlResponse({ errors: [{ message: 'Title is required' }] }),
    );
    expectAxiError(err, 'VALIDATION_ERROR', 'Title is required');
  });

  it('appends the path and extensions.code to the message text', async () => {
    const err = await requestError(
      gqlResponse({
        errors: [
          {
            message: 'Boom',
            path: ['issueCreate', 'issue'],
            extensions: { code: 'BAD_USER_INPUT' },
          },
        ],
      }),
    );
    // path and extensions.code ride along for debugging query shapes.
    expectAxiError(
      err,
      'UNKNOWN',
      'Boom (at issueCreate.issue) [BAD_USER_INPUT]',
    );
  });

  it('dumps the raw extensions as a hint for unclassified errors', async () => {
    const err = await requestError(
      gqlResponse({
        errors: [{ message: 'Something odd', extensions: { userError: true } }],
      }),
    );
    expect(err.code).toBe('UNKNOWN');
    expect(err.suggestions).toEqual(['extensions: {"userError":true}']);
  });

  it('maps an unclassified message without extensions to UNKNOWN with no hints', async () => {
    const err = await requestError(
      gqlResponse({ errors: [{ message: 'Something odd' }] }),
    );
    expect(err.code).toBe('UNKNOWN');
    expect(err.suggestions ?? []).toEqual([]);
  });

  it('ignores a non-array errors value and maps by status alone', async () => {
    // hasGqlErrors requires Array.isArray(errors) — an errors OBJECT on a 200
    // must not be mistaken for GraphQL errors: the request succeeds and the
    // data payload is returned untouched.
    const viewer = { viewer: { id: 'u-1' } };
    const fetchMock = stubSequencedFetch(
      gqlResponse({ data: viewer, errors: { message: 'x' } }),
    );
    const data = await linearRequest(FAKE_KEY, QUERY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(data).toEqual(viewer);
  });
});

describe('LINEAR_AXI_DEBUG error dump', () => {
  it('prints query, variables, and raw body to stderr when set', async () => {
    vi.stubEnv('LINEAR_AXI_DEBUG', '1');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const body = { errors: [{ message: 'Issue not found' }] };
      stubSequencedFetch({ ...httpError(404, body) } as Response);
      const err = (await linearRequest(FAKE_KEY, QUERY, { id: 'LIN-1' }).catch(
        (e: unknown) => e,
      )) as AxiError;

      expect(err.code).toBe('NOT_FOUND');
      // Each dump is console.error(label, value) — join each call's args.
      const lines = errorSpy.mock.calls.map((c) => c.join(' '));
      expect(lines).toEqual([
        `[linear-axi] query: ${QUERY}`,
        '[linear-axi] variables: {"id":"LIN-1"}',
        `[linear-axi] raw body: ${JSON.stringify(body)}`,
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
