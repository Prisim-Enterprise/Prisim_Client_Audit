// Turns PostgREST, Storage and Edge Function failures into messages a user
// can act on. Raw provider or database details are never shown.

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type PostgrestLike = { code?: string; message?: string };

// Messages raised by our SQL functions are written for users; pass them on.
const SAFE_DATABASE_MESSAGES = [
  /^A tenant must keep at least one active owner$/,
  /^Only owners can manage owners and admins$/,
  /^A sync is already queued or running for this connection$/,
  /^Published audits (are immutable|cannot be deleted; archive them instead)$/,
  /^Findings of a published audit are immutable$/,
  /^Publish the audit before sharing its report$/,
  /^Audit cannot move from \w+ to \w+$/,
  /^Invitation is not pending$/,
  /^Account does not belong to this connection$/,
  /^Too many (requests|invitations), try again later$/,
];

export function databaseError(error: PostgrestLike | null | undefined, fallback = "The request could not be completed."): ApiError {
  const code = error?.code ?? "unknown";
  const message = error?.message ?? "";
  if (code === "PGRST202" || code === "42883") {
    return new ApiError(
      "This feature needs the pending database migrations (20261105120000, 20261111100000). Ask the project owner to apply them.",
      "migration_required",
    );
  }
  if (code === "42P01" || code === "PGRST205" || code === "42703" || code === "PGRST204") {
    return new ApiError("The database schema is older than this application. Apply the pending migrations.", "migration_required");
  }
  if (SAFE_DATABASE_MESSAGES.some((pattern) => pattern.test(message))) return new ApiError(message, code);
  if (code === "42501") return new ApiError("You don't have permission to do that.", code);
  if (code === "23505") return new ApiError("That value is already in use.", code);
  if (code === "23514" || code === "22023" || code === "23503") return new ApiError("Some of the values were rejected. Check the form and try again.", code);
  if (code === "53400") return new ApiError("Too many requests. Wait a few minutes and try again.", code);
  return new ApiError(fallback, code);
}

const FUNCTION_MESSAGES: Record<string, string> = {
  not_authenticated: "Your session has expired. Sign in again.",
  not_authorized: "You don't have permission to do that for this workspace.",
  platform_admin_required: "This action requires a verified PRISIM staff session.",
  provider_not_configured: "This ad platform isn't configured on the server yet.",
  provider_error: "The ad platform rejected the request.",
  invalid_state: "The connection request expired or was already used. Start the connection again.",
  state_user_mismatch: "Finish the connection while signed in as the person who started it.",
  connection_not_pending: "This connection was already completed.",
  connection_not_found: "That connection no longer exists.",
  sync_in_progress: "A sync is already queued or running for this connection.",
  sync_not_started: "The sync could not be started. Check that the connection is still connected.",
  no_ad_accounts: "This client has no ad accounts to audit yet.",
  no_campaign_data: "No campaign data exists for the selected accounts and period. Run a sync first.",
  invalid_period: "Choose an audit period between 7 and 366 days.",
  audit_not_saved: "The audit ran but could not be saved.",
  audit_not_published: "Publish the audit before sharing its report with the client.",
  report_generation_failed: "The report could not be generated. Try again.",
  origin_not_allowed: "This application origin is not allowed by the server (check APP_URL).",
  server_configuration_error: "The server is missing required configuration.",
  invitation_not_created: "The invitation could not be created.",
  invitation_email_not_sent: "The invitation email could not be sent. Check the Auth SMTP settings.",
};

/** Error from supabase.functions.invoke (FunctionsHttpError / FunctionsFetchError / FunctionsRelayError). */
export async function functionError(error: unknown, functionName: string): Promise<ApiError> {
  const context = (error as { context?: unknown })?.context;
  if (context instanceof Response) {
    let body: Record<string, unknown> = {};
    try {
      body = (await context.clone().json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (context.status === 404 && typeof body.error !== "string") {
      return new ApiError(`The ${functionName} service is not deployed yet.`, "function_not_deployed");
    }
    const code = typeof body.error === "string" ? body.error : `http_${context.status}`;
    const providerMessage = typeof body.message === "string" ? body.message : null;
    const message = providerMessage && code === "provider_error"
      ? providerMessage
      : FUNCTION_MESSAGES[code] ?? "The request could not be completed.";
    return new ApiError(message, code, body);
  }
  return new ApiError(
    `The ${functionName} service could not be reached. It may not be deployed yet, or the network is unavailable.`,
    "function_unreachable",
  );
}

export function errorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
