// Tests for rate-limit retry in linearRequest (#30): HTTP 429 responses are
// retried with bounded backoff honoring Retry-After, then the SAME structured
// RATE_LIMITED AxiError mapLinearError already produces is surfaced.
//
// Network-free per the fetch-stub pattern from comment-update-delete.test.ts /
// description-file.test.ts (vi.stubGlobal('fetch', ...) + Response-like
// objects + afterEach unstub), with one addition for the delays: fake timers.
// Only setTimeout is faked (`toFake: ['setTimeout']`) so Date.now() stays REAL
// — every backoff test asserts it finished in real milliseconds, proving no
// actual sleep ran, while vi.advanceTimersByTimeAsync advances the logical
// clock one millisecond at a time to pin the exact honored delay boundaries.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { linearRequest } from '../src/linear.js';
import { AxiError, mapLinearError, exitCodeForError } from '../src/errors.js';

const FAKE_KEY = 'lin_api_fake';
const QUERY = 'query { viewer { id name email } }';
const VIEWER = { viewer: { id: 'u-1', name: 'Ada', email: 'ada@example.com' } };

function okResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ data }),
  } as Response;
}

/**
 * A 429 with a real Headers instance — the retry reads
 * `headers.get('retry-after')` off the mocked Response, so the stub must be
 * Headers-like. Omit `retryAfterSeconds` for the missing-header fallback.
 */
function rateLimitedResponse(retryAfterSeconds?: number): Response {
  const headers = new Headers();
  if (retryAfterSeconds !== undefined) {
    headers.set('retry-after', String(retryAfterSeconds));
  }
  return {
    ok: false,
    status: 429,
    headers,
    json: async () => ({ errors: [{ message: 'Too many requests' }] }),
  } as Response;
}

/** Linear documents rate limits as HTTP 400 plus this GraphQL error code. */
function linearRateLimitedResponse(resetAt?: number): Response {
  const headers = new Headers();
  if (resetAt !== undefined) {
    headers.set('x-ratelimit-requests-reset', String(resetAt));
  }
  return {
    ok: false,
    status: 400,
    headers,
    json: async () => ({
      errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }],
    }),
  } as Response;
}

/** A non-429 HTTP failure (401/500/...) with a Headers-like headers object. */
function httpErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: async () => ({ errors: [{ message: `HTTP ${status}` }] }),
  } as Response;
}

/**
 * Stub global fetch to answer with `responses` in order; the last one repeats
 * for any further calls. Returns the mock for exact call-count assertions.
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('429 then success (Retry-After honored)', () => {
  it('retries once after the Retry-After delay and succeeds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const startedAt = Date.now(); // real clock — only setTimeout is faked
    const fetchMock = stubSequencedFetch(
      rateLimitedResponse(2),
      okResponse(VIEWER),
    );

    const pending = linearRequest(FAKE_KEY, QUERY);
    // One millisecond before the honored 2s Retry-After: still waiting.
    await vi.advanceTimersByTimeAsync(2_000 - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // At exactly 2s the retry fires and the 200 resolves the request.
    await vi.advanceTimersByTimeAsync(1);
    const data = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(data).toEqual(VIEWER);
    // 2s of logical backoff, but the test never actually slept.
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('sends the same GraphQL document and variables on the retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const variables = { id: 'LIN-1' };
    const fetchMock = stubSequencedFetch(
      rateLimitedResponse(1),
      okResponse(VIEWER),
    );

    const pending = linearRequest(FAKE_KEY, QUERY, variables);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetchMock.mock.calls[0]!;
    const [retryUrl, retryInit] = fetchMock.mock.calls[1]!;
    expect(retryUrl).toBe(firstUrl);
    expect(retryInit?.body).toBe(firstInit?.body);
    expect(retryInit?.headers).toEqual(firstInit?.headers);
  });

  it('clamps an oversized Retry-After to 60s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const fetchMock = stubSequencedFetch(
      rateLimitedResponse(3_600),
      okResponse(VIEWER),
    );

    const pending = linearRequest(FAKE_KEY, QUERY);
    // Retry-After: 3600 must not be honored literally — the clamp caps it at
    // 60s, so nothing fires before t=60_000.
    await vi.advanceTimersByTimeAsync(60_000 - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('documented Linear GraphQL rate limits', () => {
  it('retries HTTP 400 with the RATELIMITED GraphQL code', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const fetchMock = stubSequencedFetch(
      linearRateLimitedResponse(),
      okResponse(VIEWER),
    );

    const pending = linearRequest(FAKE_KEY, QUERY);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual(VIEWER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors Linear’s documented request-reset header', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
    const fetchMock = stubSequencedFetch(
      linearRateLimitedResponse(Date.now() + 2_000),
      okResponse(VIEWER),
    );

    const pending = linearRequest(FAKE_KEY, QUERY);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(VIEWER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps exhausted documented rate limits to RATE_LIMITED', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const fetchMock = stubSequencedFetch(
      linearRateLimitedResponse(),
      linearRateLimitedResponse(),
      linearRateLimitedResponse(),
    );

    const pending = linearRequest(FAKE_KEY, QUERY).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3_000);
    const err = (await pending) as AxiError;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(err.code).toBe('RATE_LIMITED');
  });
});

describe('429 without a usable Retry-After (exponential fallback)', () => {
  it('falls back to 1s then 2s when the header is missing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const fetchMock = stubSequencedFetch(
      rateLimitedResponse(), // no Retry-After
      rateLimitedResponse(), // no Retry-After
      okResponse(VIEWER),
    );

    const pending = linearRequest(FAKE_KEY, QUERY);
    // First backoff: fallback 1s (not the 60s a missing header could imply).
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second backoff: fallback doubles to 2s.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const data = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(data).toEqual(VIEWER);
  });

  it('treats a non-numeric or zero Retry-After as missing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const garbage = rateLimitedResponse();
    garbage.headers.set('retry-after', 'soon');
    const zero = rateLimitedResponse(0);
    const fetchMock = stubSequencedFetch(garbage, zero, okResponse(VIEWER));

    const pending = linearRequest(FAKE_KEY, QUERY);
    // 'soon' does not parse as delay-seconds -> 1s exponential fallback.
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    // Retry-After: 0 is not a positive delay -> 2s fallback (not "immediately").
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('exhausted retries surface RATE_LIMITED', () => {
  it('stops after 3 attempts and throws mapLinearError’s 429 mapping', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const startedAt = Date.now();
    const fetchMock = stubSequencedFetch(
      rateLimitedResponse(1),
      rateLimitedResponse(1),
      rateLimitedResponse(1),
    );

    // Handler attached up-front: the promise rejects mid-advance, and a later
    // .catch would briefly leave it unhandled.
    const pending = linearRequest(FAKE_KEY, QUERY).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);

    const err = (await pending) as AxiError;

    // Exactly 3 attempts (1 initial + 2 retries), no fourth call.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The surfaced error IS mapLinearError's RATE_LIMITED — same code, message,
    // hint, and SDK exit code; retry adds nothing and changes nothing.
    const expected = mapLinearError({ status: 429, body: null });
    expect(err).toBeInstanceOf(AxiError);
    expect(err.code).toBe(expected.code);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.message).toBe(expected.message);
    expect(err.suggestions).toEqual(expected.suggestions);
    expect(exitCodeForError(err)).toBe(exitCodeForError(expected));
    // 2s of logical backoff, zero real sleeping.
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});

describe('non-429 failures are never retried', () => {
  it('fails immediately with the 500 mapping when a 429 retry hits a 500', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const fetchMock = stubSequencedFetch(
      rateLimitedResponse(1),
      httpErrorResponse(500),
    );

    const pending = linearRequest(FAKE_KEY, QUERY).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    const err = (await pending) as AxiError;

    // The 429 was retried; the 500 was NOT — the last response's mapping wins.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.message).toContain('HTTP 500');
  });

  it('does not retry a first-call 401 and sets up no timers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const fetchMock = stubSequencedFetch(httpErrorResponse(401));

    const err = (await linearRequest(FAKE_KEY, QUERY).catch(
      (e: unknown) => e,
    )) as AxiError;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err.code).toBe('AUTH_REQUIRED');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry GraphQL-level errors (200 + errors array)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const gqlError = okResponse(null);
    // 200 with a top-level errors array — never rate-limit-typed by
    // mapLinearError, so never a retry candidate.
    const body = { errors: [{ message: 'GraphQL blew up' }] };
    const fetchMock = stubSequencedFetch({
      ...gqlError,
      json: async () => body,
    } as Response);

    const err = (await linearRequest(FAKE_KEY, QUERY).catch(
      (e: unknown) => e,
    )) as AxiError;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err.message).toContain('GraphQL blew up');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry a network-level fetch failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    vi.stubGlobal('fetch', fetchMock);

    const err = (await linearRequest(FAKE_KEY, QUERY).catch(
      (e: unknown) => e,
    )) as AxiError;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.message).toContain('ECONNRESET');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('first-call success', () => {
  it('returns immediately without setting up any timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const fetchMock = stubSequencedFetch(okResponse(VIEWER));

    const data = await linearRequest(FAKE_KEY, QUERY);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(data).toEqual(VIEWER);
    expect(vi.getTimerCount()).toBe(0);
  });
});
