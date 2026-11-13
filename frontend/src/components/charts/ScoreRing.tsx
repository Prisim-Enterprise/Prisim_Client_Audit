import { scoreLabel } from "@functions/_shared/audit/engine.ts";
import { AlertTriangle, CheckCircle2, CircleAlert, ShieldCheck } from "lucide-react";
import { cn } from "../../lib/utils";

export function scoreTone(score: number) {
  if (score >= 85) return { stroke: "#117564", text: "text-accent-700", Icon: ShieldCheck };
  if (score >= 70) return { stroke: "#2563eb", text: "text-blue-700", Icon: CheckCircle2 };
  if (score >= 50) return { stroke: "#ca8a04", text: "text-amber-700", Icon: CircleAlert };
  return { stroke: "#be123c", text: "text-rose-700", Icon: AlertTriangle };
}

/** Audit health score (0-100) with label + icon so the state is never color-only. */
export function ScoreRing({ score, size = 132, showLabel = true }: { score: number | null; size?: number; showLabel?: boolean }) {
  const radius = size / 2 - 9;
  const circumference = 2 * Math.PI * radius;
  const value = score === null ? 0 : Math.min(Math.max(score, 0), 100);
  const tone = score === null ? null : scoreTone(value);
  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} role="img" aria-label={score === null ? "Not scored" : `Score ${Math.round(value)} out of 100, ${scoreLabel(value)}`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#e2e8f0" strokeWidth={10} />
          {tone && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={tone.stroke}
              strokeWidth={10}
              strokeLinecap="round"
              strokeDasharray={`${(value / 100) * circumference} ${circumference}`}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-semibold tracking-tight text-ink-950" style={{ fontSize: size / 4.2 }}>
            {score === null ? "–" : Math.round(value)}
          </span>
          <span className="text-[11px] text-slate-400">/ 100</span>
        </div>
      </div>
      {showLabel && tone && (
        <span className={cn("mt-2 inline-flex items-center gap-1 text-sm font-medium", tone.text)}>
          <tone.Icon aria-hidden="true" className="h-4 w-4" /> {scoreLabel(value)}
        </span>
      )}
    </div>
  );
}

export function ScoreBar({ label, score }: { label: string; score: number }) {
  const tone = scoreTone(score);
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-600">{label}</span>
        <span className="font-semibold tabular-nums text-ink-950">{Math.round(score)}</span>
      </div>
      <div className="mt-1.5 h-2 rounded-full bg-slate-100">
        <div className="h-2 rounded-full" style={{ width: `${Math.max(2, Math.min(100, score))}%`, background: tone.stroke }} />
      </div>
    </div>
  );
}
