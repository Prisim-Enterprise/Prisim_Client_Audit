import { ArrowLeft, CircleDashed } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";

export function PlaceholderPage({ title, description }: { title: string; description: string }) {
  const navigate = useNavigate();
  return (
    <div>
      <p className="text-sm font-medium text-accent-700">Workspace</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink-950">{title}</h1>
      <p className="mt-2 text-sm text-slate-500">{description}</p>
      <Card className="mt-8 flex min-h-72 flex-col items-center justify-center px-6 py-12 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
          <CircleDashed aria-hidden="true" className="h-6 w-6" />
        </div>
        <h2 className="mt-4 text-base font-semibold text-ink-950">This area is being prepared</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">
          The database and security foundation are in place. This workflow will be added in a later milestone.
        </p>
        <Button className="mt-6" variant="secondary" onClick={() => navigate(-1)}>
          <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Go back
        </Button>
      </Card>
    </div>
  );
}
