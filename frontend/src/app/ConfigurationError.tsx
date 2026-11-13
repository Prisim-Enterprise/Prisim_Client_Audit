import { AlertTriangle, Settings2 } from "lucide-react";
import { Brand } from "../components/Brand";

export function ConfigurationError({ errors }: { errors: string[] }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-5 py-12">
      <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-7 shadow-card sm:p-9">
        <Brand />
        <div className="mt-9 flex h-11 w-11 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
          <Settings2 aria-hidden="true" className="h-5 w-5" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold text-ink-950">Portal configuration required</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          The portal can’t connect until its public environment settings are configured. Add the values to
          <code className="mx-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs">frontend/.env.local</code>
          for local development or your Vercel project settings for deployment.
        </p>
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-amber-900">
            <AlertTriangle aria-hidden="true" className="h-4 w-4" /> Check these public variables
          </p>
          <ul className="mt-3 space-y-2 text-sm text-amber-900">
            {errors.map((error) => <li key={error} className="font-mono text-xs">{error}</li>)}
          </ul>
        </div>
        <p className="mt-5 text-xs leading-5 text-slate-500">
          Only a Supabase URL and publishable/anon key belong in frontend variables. Never add a service-role key here.
        </p>
      </div>
    </main>
  );
}
