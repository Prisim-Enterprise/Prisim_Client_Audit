import { useEffect, useMemo, useRef, useState } from "react";

export type TrendPoint = { date: string; value: number | null };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(260, Math.floor(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function niceMax(value: number) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const scaled = value / power;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * power;
}

const shortDate = (value: string) =>
  new Date(`${value}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * Single-series daily trend: area + 2px line, one y-axis, recessive grid,
 * crosshair tooltip. The series name is the chart title, so no legend box.
 */
export function TrendChart({
  points,
  label,
  format,
  height = 220,
}: {
  points: TrendPoint[];
  label: string;
  format: (value: number) => string;
  height?: number;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const padding = { top: 12, right: 12, bottom: 26, left: 56 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  const { max, coords } = useMemo(() => {
    const values = points.map((point) => point.value ?? 0);
    const top = niceMax(Math.max(0, ...values));
    const step = points.length > 1 ? innerWidth / (points.length - 1) : 0;
    return {
      max: top,
      coords: points.map((point, index) => ({
        x: padding.left + (points.length > 1 ? index * step : innerWidth / 2),
        y: point.value === null ? null : padding.top + innerHeight - (point.value / top) * innerHeight,
      })),
    };
  }, [points, innerWidth, innerHeight, padding.left, padding.top]);

  if (points.length === 0) return null;

  const defined = coords.filter((coord): coord is { x: number; y: number } => coord.y !== null);
  const line = defined.map((coord, index) => `${index === 0 ? "M" : "L"}${coord.x.toFixed(1)},${coord.y.toFixed(1)}`).join(" ");
  const baseline = padding.top + innerHeight;
  const area = defined.length > 1
    ? `${line} L${defined[defined.length - 1].x.toFixed(1)},${baseline} L${defined[0].x.toFixed(1)},${baseline} Z`
    : "";
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(innerWidth / 90))));
  const active = hover !== null ? points[hover] : null;
  const activeCoord = hover !== null ? coords[hover] : null;

  const onMove = (clientX: number, element: SVGSVGElement) => {
    const rect = element.getBoundingClientRect();
    const x = clientX - rect.left - padding.left;
    const index = points.length > 1 ? Math.round((x / innerWidth) * (points.length - 1)) : 0;
    setHover(Math.min(points.length - 1, Math.max(0, index)));
  };

  return (
    <div ref={ref} className="relative w-full">
      <svg
        role="img"
        aria-label={`${label} by day, ${shortDate(points[0].date)} to ${shortDate(points[points.length - 1].date)}`}
        width={width}
        height={height}
        className="block touch-none select-none"
        onMouseMove={(event) => onMove(event.clientX, event.currentTarget)}
        onTouchMove={(event) => onMove(event.touches[0].clientX, event.currentTarget)}
        onMouseLeave={() => setHover(null)}
        onTouchEnd={() => setHover(null)}
      >
        {ticks.map((tick) => {
          const y = padding.top + innerHeight - tick * innerHeight;
          return (
            <g key={tick}>
              <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke="#e2e8f0" strokeWidth={1} strokeDasharray={tick === 0 ? undefined : "3 4"} />
              <text x={padding.left - 8} y={y + 4} textAnchor="end" className="fill-slate-400 text-[10px]">{format(max * tick)}</text>
            </g>
          );
        })}
        {points.map((point, index) =>
          index % labelEvery === 0 ? (
            <text key={point.date} x={coords[index].x} y={height - 8} textAnchor="middle" className="fill-slate-400 text-[10px]">
              {shortDate(point.date)}
            </text>
          ) : null
        )}
        {area && <path d={area} fill="#168a78" fillOpacity={0.1} />}
        {line && <path d={line} fill="none" stroke="#117564" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {activeCoord && (
          <g>
            <line x1={activeCoord.x} x2={activeCoord.x} y1={padding.top} y2={baseline} stroke="#94a3b8" strokeWidth={1} />
            {activeCoord.y !== null && <circle cx={activeCoord.x} cy={activeCoord.y} r={4.5} fill="#117564" stroke="#fff" strokeWidth={2} />}
          </g>
        )}
      </svg>
      {active && activeCoord && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg"
          style={{
            left: Math.min(Math.max(activeCoord.x - 70, 0), width - 150),
          }}
        >
          <p className="text-slate-500">{shortDate(active.date)}</p>
          <p className="mt-0.5 font-semibold text-ink-950">{active.value === null ? "No data" : format(active.value)}</p>
          <p className="text-slate-500">{label}</p>
        </div>
      )}
    </div>
  );
}

/** Horizontal bars for a ranked share (e.g. spend by campaign). Single hue. */
export function BarList({
  items,
  format,
}: {
  items: Array<{ key: string; label: string; value: number; detail?: string }>;
  format: (value: number) => string;
}) {
  const max = Math.max(0, ...items.map((item) => item.value));
  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item.key} className="group" title={`${item.label}: ${format(item.value)}`}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate text-slate-700">{item.label}</span>
            <span className="shrink-0 font-medium tabular-nums text-ink-950">{format(item.value)}</span>
          </div>
          <div className="mt-1.5 h-2 rounded-full bg-slate-100">
            <div className="h-2 rounded-full bg-accent-600 transition-all group-hover:bg-accent-700" style={{ width: `${max > 0 ? Math.max(2, (item.value / max) * 100) : 0}%` }} />
          </div>
          {item.detail && <p className="mt-1 text-xs text-slate-500">{item.detail}</p>}
        </li>
      ))}
    </ul>
  );
}
