import { describe, it, expect } from 'vitest';
import { mapLinearError, networkError, missingKeyError } from '../src/errors.js';

describe('mapLinearError', () => {
  it('maps 401 to AUTH_REQUIRED', () => {
    const err = mapLinearError({ status: 401, body: null });
    expect(err.code).toBe('AUTH_REQUIRED');
    expect(err.suggestions.length).toBeGreaterThan(0);
  });

  it('maps 429 to RATE_LIMITED', () => {
    const err = mapLinearError({ status: 429, body: null });
    expect(err.code).toBe('RATE_LIMITED');
  });

  it('maps 5xx to NETWORK_ERROR', () => {
    const err = mapLinearError({ status: 503, body: null });
    expect(err.code).toBe('NETWORK_ERROR');
  });

  it('maps a GraphQL not-found error', () => {
    const err = mapLinearError({
      status: 200,
      body: { errors: [{ message: 'Entity not found' }] },
    });
    expect(err.code).toBe('NOT_FOUND');
  });

  it('maps a GraphQL validation error', () => {
    const err = mapLinearError({
      status: 200,
      body: {
        errors: [{ message: 'x', extensions: { userError: 'Title is required' } }],
      },
    });
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toContain('Title is required');
  });
});

describe('error helpers', () => {
  it('networkError wraps a message', () => {
    const err = networkError(new Error('ETIMEDOUT'));
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.message).toContain('ETIMEDOUT');
  });

  it('missingKeyError is actionable', () => {
    const err = missingKeyError();
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.suggestions.some((s) => s.includes('LINEAR_API_KEY'))).toBe(true);
  });
});
