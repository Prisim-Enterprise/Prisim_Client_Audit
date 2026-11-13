import {
  createInviteHandler,
  type InvitationDependencies,
} from "./index.ts";

const config = {
  supabaseUrl: "https://example.supabase.co",
  anonKey: "sb_publishable_test_key",
  serviceRoleKey: "server-only-test-secret",
  appUrl: "https://portal.example.com",
};

const tenantId = "a1000000-0000-4000-8000-000000000001";
const invitationId = "a2000000-0000-4000-8000-000000000002";
const expiresAt = "2026-11-18T12:00:00.000Z";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function createDependencies(overrides: Partial<InvitationDependencies> = {}) {
  const state: {
    authenticated: string[];
    actions: Array<{ authorization: string; tenantId: string }>;
    invitations: Array<{
      actionId: string;
      tenantId: string;
      email: string;
      role: string;
      tokenHash: string;
    }>;
    deliveries: Array<{ email: string; redirectUrl: string }>;
    failures: Array<{ actionId: string; invitationId: string }>;
  } = {
    authenticated: [],
    actions: [],
    invitations: [],
    deliveries: [],
    failures: [],
  };
  const dependencies: InvitationDependencies = {
    async authenticate(token) {
      state.authenticated.push(token);
      return true;
    },
    async beginAction(authorization, requestedTenantId) {
      state.actions.push({ authorization, tenantId: requestedTenantId });
      return "action-123";
    },
    async createInvitation(actionId, requestedTenantId, email, role, tokenHash) {
      state.invitations.push({
        actionId,
        tenantId: requestedTenantId,
        email,
        role,
        tokenHash,
      });
      return { id: invitationId, expiresAt };
    },
    async sendInvitation(email, redirectUrl) {
      state.deliveries.push({ email, redirectUrl });
      return true;
    },
    async failInvitation(actionId, failedInvitationId) {
      state.failures.push({ actionId, invitationId: failedInvitationId });
      return true;
    },
    ...overrides,
  };
  return { dependencies, state };
}

function inviteRequest(options: {
  authorization?: string;
  origin?: string;
  body?: unknown;
  method?: string;
} = {}) {
  const headers = new Headers();
  if (options.authorization) headers.set("Authorization", options.authorization);
  if (options.origin) headers.set("Origin", options.origin);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request("https://function.example.test/invite", {
    method: options.method ?? "POST",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function responseBody(response: Response) {
  return await response.json() as Record<string, unknown>;
}

Deno.test("rejects unauthenticated invitation creation before authorization", async () => {
  const { dependencies, state } = createDependencies();
  const handler = createInviteHandler(config, dependencies);
  const response = await handler(inviteRequest({
    body: { tenantId, email: "client@example.com", role: "client" },
  }));

  assert(response.status === 401, "expected unauthenticated request rejection");
  assert(state.actions.length === 0, "unauthenticated request must not begin privileged action");
  assert(state.invitations.length === 0, "unauthenticated request must not create invitations");
});

Deno.test("rejects invalid input without calling authorization or email delivery", async () => {
  const { dependencies, state } = createDependencies();
  const handler = createInviteHandler(config, dependencies);
  const response = await handler(inviteRequest({
    authorization: "Bearer user-token",
    body: { tenantId: "not-a-uuid", email: "client@example.com", role: "client" },
  }));

  assert(response.status === 400, "expected invalid request response");
  assert(state.authenticated.length === 0, "invalid input must not call Auth");
  assert(state.deliveries.length === 0, "invalid input must not send email");
});

Deno.test("does not create an invitation when platform authorization fails", async () => {
  const { dependencies, state } = createDependencies({
    async beginAction() {
      return null;
    },
  });
  const handler = createInviteHandler(config, dependencies);
  const response = await handler(inviteRequest({
    authorization: "Bearer user-token",
    origin: config.appUrl,
    body: { tenantId, email: "client@example.com", role: "client" },
  }));

  assert(response.status === 403, "expected authorization failure");
  assert(state.invitations.length === 0, "unauthorized request must not create an invitation");
  assert(state.deliveries.length === 0, "unauthorized request must not send email");
});

Deno.test("stores only a SHA-256 token hash and returns no raw token", async () => {
  const { dependencies, state } = createDependencies();
  const handler = createInviteHandler(config, dependencies);
  const response = await handler(inviteRequest({
    authorization: "Bearer user-token",
    origin: config.appUrl,
    body: { tenantId, email: " Client@Example.com ", role: "client" },
  }));
  const body = await responseBody(response);
  const created = state.invitations[0];
  const delivery = state.deliveries[0];

  assert(response.status === 200, "expected successful invitation creation");
  assert(created?.email === "client@example.com", "email should be normalized");
  assert(created?.tokenHash.length === 64, "persisted token must be a SHA-256 hex digest");
  assert(/^[0-9a-f]{64}$/.test(created.tokenHash), "stored token must be lowercase hex");
  assert(delivery?.email === "client@example.com", "normalized recipient should receive the invite");

  const redirect = new URL(delivery.redirectUrl);
  const rawToken = redirect.searchParams.get("token");
  assert(redirect.origin === config.appUrl, "acceptance link must use the configured app origin");
  assert(redirect.pathname === "/accept-invite", "acceptance link must use the invitation route");
  assert(rawToken && rawToken.length === 64, "email acceptance link must contain the one-time token");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawToken));
  const expectedHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  assert(created.tokenHash === expectedHash, "database input must be the hash of the emailed token");
  assert(!JSON.stringify(body).includes(rawToken), "browser response must not disclose raw token");
  assert(body.invitation_id === invitationId, "response should identify the created invitation");
  assert(body.invitation_expires_at === expiresAt, "response should include invitation expiry");
  assert(
    state.actions[0]?.authorization === "Bearer user-token",
    "privileged action must use the authenticated caller's bearer token",
  );
});

Deno.test("revokes failed email deliveries and reports cleanup failures", async () => {
  const { dependencies, state } = createDependencies({
    async sendInvitation() {
      return false;
    },
  });
  const handler = createInviteHandler(config, dependencies);
  const response = await handler(inviteRequest({
    authorization: "Bearer user-token",
    body: { tenantId, email: "client@example.com", role: "client" },
  }));

  assert(response.status === 502, "delivery failure should be reported");
  assert(state.failures.length === 1, "failed delivery must revoke the invitation");
  assert(state.failures[0]?.invitationId === invitationId, "cleanup must target the pending invite");

  const cleanupFailed = createDependencies({
    async sendInvitation() {
      return false;
    },
    async failInvitation() {
      return false;
    },
  });
  const cleanupHandler = createInviteHandler(config, cleanupFailed.dependencies);
  const cleanupResponse = await cleanupHandler(inviteRequest({
    authorization: "Bearer user-token",
    body: { tenantId, email: "client@example.com", role: "client" },
  }));
  const cleanupBody = await responseBody(cleanupResponse);

  assert(cleanupResponse.status === 500, "cleanup failure must not look successful");
  assert(
    cleanupBody.error === "invitation_delivery_cleanup_failed",
    "cleanup failure should have an explicit error code",
  );
});

Deno.test("rejects a request from an unapproved browser origin", async () => {
  const { dependencies, state } = createDependencies();
  const handler = createInviteHandler(config, dependencies);
  const response = await handler(inviteRequest({
    authorization: "Bearer user-token",
    origin: "https://attacker.example",
    body: { tenantId, email: "client@example.com", role: "client" },
  }));

  assert(response.status === 403, "expected cross-origin request rejection");
  assert(state.authenticated.length === 0, "origin check should happen before Auth request");
});
