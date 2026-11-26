// PostgREST caps responses (1,000 rows by default); page through results.
// Reaching maxRows with a full last page means more rows exist: that is an
// error, never a silently truncated result.

type RangeQuery<T> = {
  range(from: number, to: number): PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
};

export class TruncatedResultError extends Error {
  constructor(readonly maxRows: number) {
    super(`More than ${maxRows} rows; the result would be incomplete.`);
    this.name = "TruncatedResultError";
  }
}

export async function fetchAllRows<T>(query: () => RangeQuery<T>, pageSize = 1000, maxRows = 50000): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await query().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) return rows;
    if (rows.length >= maxRows) throw new TruncatedResultError(maxRows);
  }
}
