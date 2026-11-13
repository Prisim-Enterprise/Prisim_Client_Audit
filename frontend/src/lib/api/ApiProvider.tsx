import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, type PropsWithChildren } from "react";
import type { PortalApi, RealtimeTable } from "./types";

const ApiContext = createContext<PortalApi | null>(null);

export function ApiProvider({ api, children }: PropsWithChildren<{ api: PortalApi }>) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): PortalApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi must be used inside ApiProvider.");
  return api;
}

export const queryKeys = {
  overview: ["overview"] as const,
  tenants: ["tenants"] as const,
  tenant: (tenantId: string) => ["tenants", tenantId] as const,
  members: (tenantId: string) => ["members", tenantId] as const,
  invitations: (tenantId: string) => ["invitations", tenantId] as const,
  integrations: ["integrations"] as const,
  connections: (tenantId?: string) => ["connections", tenantId ?? "all"] as const,
  adAccounts: (tenantId?: string) => ["ad-accounts", tenantId ?? "all"] as const,
  syncJobs: (tenantId?: string) => ["sync-jobs", tenantId ?? "all"] as const,
  syncStatus: (tenantId: string) => ["sync-status", tenantId] as const,
  campaigns: (tenantId: string, from: string, to: string, account?: string) => ["campaigns", tenantId, from, to, account ?? "all"] as const,
  daily: (tenantId: string, from: string, to: string, account?: string) => ["daily", tenantId, from, to, account ?? "all"] as const,
  auditRuns: (tenantId?: string) => ["audit-runs", tenantId ?? "all"] as const,
  auditRun: (auditRunId: string) => ["audit-run", auditRunId] as const,
  findings: (auditRunId: string) => ["findings", auditRunId] as const,
  reports: (tenantId?: string) => ["reports", tenantId ?? "all"] as const,
  activity: (tenantId?: string) => ["activity", tenantId ?? "all"] as const,
};

const INVALIDATES: Record<RealtimeTable, string[]> = {
  sync_jobs: ["sync-jobs", "sync-status", "overview", "connections"],
  ad_accounts: ["ad-accounts", "campaigns", "daily", "connections", "sync-status"],
  audit_runs: ["audit-runs", "audit-run", "overview"],
  reports: ["reports", "overview"],
};

/** Subscribes to Supabase Realtime (RLS-filtered) and refreshes affected queries. */
export function useRealtime(tables: RealtimeTable[]) {
  const api = useApi();
  const queryClient = useQueryClient();
  const key = tables.join(",");
  useEffect(() => {
    const list = key.split(",") as RealtimeTable[];
    const prefixes = new Set(list.flatMap((table) => INVALIDATES[table]));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api.subscribe(list, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void queryClient.invalidateQueries({
          predicate: (query) => prefixes.has(String(query.queryKey[0])),
        });
      }, 300);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [api, queryClient, key]);
}
