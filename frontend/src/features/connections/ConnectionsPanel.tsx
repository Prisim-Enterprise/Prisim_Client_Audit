import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Link2, PlugZap, RefreshCw, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Alert } from "../../components/ui/Alert";
import { ProviderBadge, StatusBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { ConfirmButton } from "../../components/ui/Controls";
import { LoadingState } from "../../components/ui/LoadingState";
import { EmptyState, ErrorState, SectionCard } from "../../components/ui/States";
import { formatDateTime, relativeTime } from "../../lib/analytics";
import { queryKeys, useApi, useRealtime } from "../../lib/api/ApiProvider";
import { errorMessage } from "../../lib/api/errors";
import type { AdAccount, Connection, IntegrationStatus, Provider } from "../../lib/api/types";

export const OAUTH_RETURN_KEY = "prisim.oauth.return";

const PROVIDER_COPY: Record<Provider, { name: string; approval: string; scopes: string }> = {
  meta: {
    name: "Meta Ads",
    approval: "Live access also needs Meta App Review approval for ads_read (and business_management for Business Manager accounts).",
    scopes: "Read-only access to ad accounts, campaigns and insights (ads_read).",
  },
  google: {
    name: "Google Ads",
    approval: "Live access also needs an approved Google Ads developer token (Basic access) and a verified OAuth consent screen.",
    scopes: "Read-only reporting access through the Google Ads API (adwords scope).",
  },
};

export function ConnectionsPanel({ tenantId, canManage }: { tenantId: string; canManage: boolean }) {
  const api = useApi();
  useRealtime(["ad_accounts", "sync_jobs"]);

  const accountsQuery = useQuery({ queryKey: queryKeys.adAccounts(tenantId), queryFn: () => api.listAdAccounts(tenantId) });
  const connectionsQuery = useQuery({
    queryKey: queryKeys.connections(tenantId),
    queryFn: () => api.listConnections(tenantId),
    enabled: canManage,
  });
  const integrationsQuery = useQuery({
    queryKey: queryKeys.integrations,
    queryFn: () => api.getIntegrationStatus(),
    enabled: canManage,
    staleTime: 5 * 60_000,
  });
  const syncQuery = useQuery({ queryKey: queryKeys.syncStatus(tenantId), queryFn: () => api.getTenantSyncStatus(tenantId) });

  const accounts = accountsQuery.data ?? [];
  const connections = (connectionsQuery.data ?? []).filter((connection) => connection.status !== "revoked");

  return (
    <div className="space-y-5">
      {canManage && (
        <div className="grid gap-4 lg:grid-cols-2">
          {(["meta", "google"] as const).map((provider) => (
            <ProviderCard key={provider} provider={provider} tenantId={tenantId} status={integrationsQuery.data} loading={integrationsQuery.isLoading} />
          ))}
        </div>
      )}

      {syncQuery.data && syncQuery.data.length > 0 && (
        <div className="flex flex-wrap gap-3 text-sm text-slate-600">
          {syncQuery.data.map((status) => (
            <span key={status.provider} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
              <ProviderBadge provider={status.provider} />
              <StatusBadge status={status.last_status} />
              <span className="text-xs text-slate-500">last success {relativeTime(status.last_successful_sync_at)}</span>
            </span>
          ))}
        </div>
      )}

      {canManage ? (
        connectionsQuery.isLoading || accountsQuery.isLoading ? (
          <Card><LoadingState label="Loading connections…" /></Card>
        ) : connectionsQuery.error ? (
          <Card><ErrorState error={connectionsQuery.error} onRetry={() => void connectionsQuery.refetch()} /></Card>
        ) : connections.length === 0 ? (
          <Card>
            <EmptyState icon={<Link2 />} title="No ad platforms connected" description="Connect Meta Ads or Google Ads above. PRISIM only requests read-only reporting access." />
          </Card>
        ) : (
          connections.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              accounts={accounts.filter((account) => account.connection_id === connection.id)}
              tenantId={tenantId}
            />
          ))
        )
      ) : (
        <ReadOnlyAccounts accounts={accounts} loading={accountsQuery.isLoading} error={accountsQuery.error} />
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  tenantId,
  status,
  loading,
}: {
  provider: Provider;
  tenantId: string;
  status: IntegrationStatus | undefined;
  loading: boolean;
}) {
  const api = useApi();
  const location = useLocation();
  const navigate = useNavigate();
  const copy = PROVIDER_COPY[provider];
  const availability = status?.state === "available" ? status.providers[provider] : null;
  const start = useMutation({
    mutationFn: () => api.startOAuth(tenantId, provider),
    onSuccess: ({ authorizeUrl }) => {
      try {
        sessionStorage.setItem(OAUTH_RETURN_KEY, location.pathname);
      } catch {
        // Storage unavailable: the callback falls back to the workspace home.
      }
      // Provider consent pages are external; demo mode returns an in-app URL.
      if (authorizeUrl.startsWith("/")) navigate(authorizeUrl);
      else window.location.assign(authorizeUrl);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <ProviderBadge provider={provider} />
          <h3 className="mt-2 font-semibold text-ink-950">Connect {copy.name}</h3>
          <p className="mt-1 text-sm leading-6 text-slate-500">{copy.scopes}</p>
        </div>
        <Button
          size="small"
          onClick={() => start.mutate()}
          loading={start.isPending}
          disabled={loading || !availability?.configured}
        >
          <PlugZap aria-hidden="true" className="h-4 w-4" /> Connect
        </Button>
      </div>
      {loading ? null : status?.state === "service_unavailable" ? (
        <Alert tone="info" className="mt-4" title="Live connection unavailable">
          {status.message} The ad-connections Edge Function must be deployed with its secrets before accounts can be connected.
        </Alert>
      ) : availability && !availability.configured ? (
        <Alert tone="info" className="mt-4" title="Requires external credentials">
          <p>Server secrets not set: <span className="font-mono text-xs">{availability.missing.join(", ")}</span>.</p>
          <p className="mt-1">{copy.approval}</p>
        </Alert>
      ) : null}
    </Card>
  );
}

function ConnectionCard({ connection, accounts, tenantId }: { connection: Connection; accounts: AdAccount[]; tenantId: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>(() => accounts.filter((account) => account.sync_enabled).map((account) => account.id));
  const savedKey = accounts.filter((account) => account.sync_enabled).map((account) => account.id).sort().join(",");
  useEffect(() => setSelected(savedKey ? savedKey.split(",") : []), [savedKey]);
  const dirty = [...selected].sort().join(",") !== savedKey;
  const lastSync = accounts.map((account) => account.last_synced_at).filter(Boolean).sort().at(-1) ?? null;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.adAccounts(tenantId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.connections(tenantId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.syncStatus(tenantId) });
  };
  const save = useMutation({
    mutationFn: () => api.setAdAccountSync(connection.id, selected),
    onSuccess: (count) => {
      toast.success(`${count} ad account${count === 1 ? "" : "s"} selected for sync`);
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const sync = useMutation({
    mutationFn: (jobType: "manual_sync" | "backfill") => api.startSync(connection.id, jobType),
    onSuccess: () => {
      toast.success("Sync started. Data updates here when it finishes.");
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const healthy = connection.status === "connected";
  return (
    <SectionCard
      title={
        <span className="flex flex-wrap items-center gap-2">
          <ProviderBadge provider={connection.provider} />
          <span className="text-slate-300">·</span>
          <span>{connection.account_name ?? "Connection"}</span>
          <StatusBadge status={connection.status} />
        </span>
      }
      description={`Connected ${formatDateTime(connection.created_at)} · last data ${relativeTime(lastSync)}${connection.token_expires_at ? ` · access expires ${formatDateTime(connection.token_expires_at)}` : ""}`}
      actions={
        <>
          <Button size="small" variant="secondary" disabled={!healthy || selected.length === 0 || dirty} loading={sync.isPending && sync.variables === "manual_sync"} onClick={() => sync.mutate("manual_sync")}>
            <RefreshCw aria-hidden="true" className="h-4 w-4" /> Sync now
          </Button>
          <Button size="small" variant="ghost" disabled={!healthy || selected.length === 0 || dirty} loading={sync.isPending && sync.variables === "backfill"} onClick={() => sync.mutate("backfill")}>
            Backfill 90 days
          </Button>
          <ConfirmButton
            title={`Disconnect ${PROVIDER_COPY[connection.provider].name}?`}
            description="PRISIM deletes the stored access credentials and asks the platform to revoke access. Data already synced stays available for past audits."
            confirmLabel="Disconnect"
            onConfirm={async () => {
              try {
                await api.disconnect(connection.id);
                toast.success("Connection removed");
                refresh();
              } catch (error) {
                toast.error(errorMessage(error));
              }
            }}
            variant="ghost"
          >
            <Unplug aria-hidden="true" className="h-4 w-4" /> Disconnect
          </ConfirmButton>
        </>
      }
    >
      {!healthy && (
        <div className="px-5 pt-4 sm:px-6">
          <Alert tone="error" title="Reconnect required">
            {connection.status === "expired"
              ? "The platform access has expired. Connect the account again to resume daily syncs."
              : "The last connection attempt failed. Connect the account again."}
          </Alert>
        </div>
      )}
      {accounts.length === 0 ? (
        <EmptyState icon={<KeyRound />} title="No ad accounts were found" description="The signed-in platform user has no accessible ad accounts, or access was not granted. Reconnect with a user that can view the ad accounts." />
      ) : (
        <div>
          <ul className="divide-y divide-slate-100">
            {accounts.map((account) => (
              <li key={account.id} className="flex items-center gap-3 px-5 py-3 sm:px-6">
                <input
                  id={`sync-${account.id}`}
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-accent-600 focus:ring-accent-500"
                  checked={selected.includes(account.id)}
                  onChange={(event) =>
                    setSelected((current) => event.target.checked ? [...current, account.id] : current.filter((value) => value !== account.id))}
                />
                <label htmlFor={`sync-${account.id}`} className="min-w-0 flex-1 cursor-pointer">
                  <span className="block truncate text-sm font-medium text-ink-950">{account.account_name ?? account.external_account_id}</span>
                  <span className="block text-xs text-slate-500">
                    {account.external_account_id} · {account.currency ?? "currency unknown"} · {account.timezone ?? "timezone unknown"}
                  </span>
                </label>
                <StatusBadge status={account.status} />
                <span className="hidden w-28 text-right text-xs text-slate-500 sm:block">{account.sync_enabled ? `synced ${relativeTime(account.last_synced_at)}` : "not synced"}</span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-5 py-3 sm:px-6">
            <p className="text-xs text-slate-500">Selected accounts are synced daily and included in audits.</p>
            <Button size="small" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>Save selection</Button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function ReadOnlyAccounts({ accounts, loading, error }: { accounts: AdAccount[]; loading: boolean; error: unknown }) {
  if (loading) return <Card><LoadingState label="Loading ad accounts…" /></Card>;
  if (error) return <Card><ErrorState error={error} /></Card>;
  if (accounts.length === 0) {
    return <Card><EmptyState icon={<Link2 />} title="No ad accounts connected yet" description="A workspace manager or your PRISIM team can connect Meta and Google Ads accounts." /></Card>;
  }
  return (
    <SectionCard title="Connected ad accounts" description="Ask a workspace manager to change connections.">
      <ul className="divide-y divide-slate-100">
        {accounts.map((account) => (
          <li key={account.id} className="flex flex-wrap items-center gap-3 px-5 py-3 sm:px-6">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink-950">{account.account_name ?? account.external_account_id}</p>
              <p className="text-xs text-slate-500"><ProviderBadge provider={account.provider} /> · {account.currency ?? "–"}</p>
            </div>
            <StatusBadge status={account.sync_enabled ? "active" : "inactive"} />
            <span className="text-xs text-slate-500">updated {relativeTime(account.last_synced_at)}</span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
