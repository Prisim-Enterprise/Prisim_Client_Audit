// sync-ad-data: pulls campaigns and daily campaign metrics from Meta / Google.
//
//   start          (user JWT)  manager+ or aal2 staff queues a manual sync or
//                              backfill for one connection; processed in the
//                              background after the 202 response
//   run-scheduled  (cron)      authenticated by the x-prisim-cron-secret header;
//                              queues due daily syncs and drains the queue
//
// verify_jwt is disabled for this function because pg_cron calls it with a
// shared secret; every request is authenticated here instead.

import { HttpError, isUuid, json, readBody } from "../_shared/http.ts";
import { constantTimeEqualText } from "../_shared/oauth-state.ts";
import type { ClaimedJob } from "../_shared/sync.ts";

export type SyncHandlerDependencies = {
  cronSecret: string | undefined;
  authenticate(jwt: string): Promise<string | null>;
  connectionTenant(connectionId: string): Promise<string | null>;
  beginSyncAction(jwt: string, tenantId: string, connectionId: string): Promise<string | null>;
  startJob(actionId: string, connectionId: string, jobType: "manual_sync" | "backfill"): Promise<{ jobId: string } | { conflict: true } | null>;
  enqueueScheduled(): Promise<number>;
  claim(jobId: string | null): Promise<ClaimedJob | null>;
  process(job: ClaimedJob): Promise<{ success: boolean; error: string | null }>;
  background(task: Promise<unknown>): void;
  now(): number;
};

/** Wall-clock budget for one invocation (Free plan limit is 150 s). */
const DRAIN_BUDGET_MS = 110_000;

export async function drainQueue(deps: SyncHandlerDependencies, firstJobId: string | null = null) {
  const started = deps.now();
  let processed = 0;
  let nextId = firstJobId;
  while (deps.now() - started < DRAIN_BUDGET_MS) {
    const job = await deps.claim(nextId);
    if (!job) {
      if (nextId) {
        nextId = null;
        continue;
      }
      break;
    }
    nextId = null;
    await deps.process(job);
    processed++;
    if (firstJobId) break; // A manual start processes only its own job.
  }
  return processed;
}

export function createSyncHandler(deps: SyncHandlerDependencies) {
  return async (request: Request, origin: string, jwt: string | null): Promise<Response> => {
    const body = await readBody(request);

    if (body.action === "run-scheduled") {
      const provided = request.headers.get("x-prisim-cron-secret") ?? "";
      if (!deps.cronSecret || deps.cronSecret.length < 32 || !constantTimeEqualText(provided, deps.cronSecret)) {
        throw new HttpError(401, "not_authenticated");
      }
      const queued = await deps.enqueueScheduled();
      deps.background(drainQueue(deps));
      return json(202, { queued }, origin);
    }

    if (body.action === "start") {
      if (!jwt) throw new HttpError(401, "not_authenticated");
      const userId = await deps.authenticate(jwt);
      if (!userId) throw new HttpError(401, "not_authenticated");
      if (!isUuid(body.connectionId)) throw new HttpError(400, "invalid_request");
      const jobType = body.jobType === "backfill" ? "backfill" : "manual_sync";

      const tenantId = await deps.connectionTenant(body.connectionId);
      if (!tenantId) throw new HttpError(404, "connection_not_found");
      const actionId = await deps.beginSyncAction(jwt, tenantId, body.connectionId);
      if (!actionId) throw new HttpError(403, "not_authorized");
      const started = await deps.startJob(actionId, body.connectionId, jobType);
      if (!started) throw new HttpError(409, "sync_not_started");
      if ("conflict" in started) throw new HttpError(409, "sync_in_progress");

      deps.background(drainQueue(deps, started.jobId));
      return json(202, { jobId: started.jobId, status: "queued" }, origin);
    }

    throw new HttpError(400, "invalid_request");
  };
}
