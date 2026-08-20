/**
 * Shared formatting helpers for consistent count phrasing.
 *
 *   count: N                          — simple count
 *   count: N of T total               — when a total is known
 *   count: N (showing first N)        — when truncated by limit
 */
export interface CountLineOptions {
  /** Number of items returned / displayed. */
  count: number;
  /** The request limit; when count === limit, results may be truncated. */
  limit?: number;
  /** True total count from an API connection. */
  totalCount?: number;
  /**
   * Whether more results exist beyond the returned slice, when the caller
   * knows it from the connection's pageInfo.hasNextPage. Takes precedence
   * over the count === limit heuristic (which guesses).
   */
  hasMore?: boolean;
}

export function formatCountLine(opts: CountLineOptions): string {
  const { count, limit, totalCount, hasMore } = opts;

  if (totalCount !== undefined && totalCount !== null && totalCount >= count) {
    return `count: ${count} of ${totalCount} total`;
  }

  // More results existed — results are truncated. Prefer the explicit
  // pageInfo signal when present; fall back to the limit heuristic.
  const truncated =
    hasMore ?? (limit !== undefined && count === limit && count > 0);

  if (truncated && count > 0) {
    return `count: ${count} (showing first ${count})`;
  }

  return `count: ${count}`;
}
