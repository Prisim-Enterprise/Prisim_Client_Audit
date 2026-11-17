import { parseAuthContext, type AuthContextData, type UserProfile } from "./auth-context";

type QueryError = {
  code?: string;
};

type QueryResult<T> = {
  data: T;
  error: QueryError | null;
};

type AuthSnapshot = {
  context: AuthContextData;
  profile: UserProfile | null;
};

function accountAccessError(
  contextError: QueryError | null,
  profileError: QueryError | null,
): Error {
  if (contextError?.code === "PGRST202") {
    return new Error(
      "Authentication succeeded, but the account context RPC public.get_my_context() is missing from the database schema (PGRST202). Migration 20261105120000_security_hardening.sql defines this function.",
    );
  }

  const failures: string[] = [];
  if (contextError) {
    failures.push(`public.get_my_context() failed${contextError.code ? ` (${contextError.code})` : ""}`);
  }
  if (profileError) {
    failures.push(`the caller's profile query failed${profileError.code ? ` (${profileError.code})` : ""}`);
  }
  return new Error(`Account access could not be loaded: ${failures.join("; ")}.`);
}

export async function loadAuthSnapshot(
  authenticatedUserId: string,
  loadContext: () => Promise<QueryResult<unknown>>,
  loadProfile: () => Promise<QueryResult<UserProfile | null>>,
): Promise<AuthSnapshot> {
  const [contextResult, profileResult] = await Promise.all([
    loadContext(),
    loadProfile(),
  ]);

  if (contextResult.error || profileResult.error) {
    throw accountAccessError(contextResult.error, profileResult.error);
  }

  return {
    context: parseAuthContext(contextResult.data, authenticatedUserId),
    profile: profileResult.data,
  };
}
