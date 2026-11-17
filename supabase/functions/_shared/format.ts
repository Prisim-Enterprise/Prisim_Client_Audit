// Formatting helpers shared by the audit engine, PDF report and frontend.
// Output is plain ASCII so it renders with the PDF standard fonts.

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

function locale(currency: string | null | undefined) {
  return currency === "INR" ? "en-IN" : "en-US";
}

export function formatNumber(value: number | null | undefined, digits = 0, currency?: string | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat(locale(currency), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatMoney(value: number | null | undefined, currency: string | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const code = currency && /^[A-Z]{3}$/.test(currency) ? currency : "";
  const amount = formatNumber(value, digits, code);
  return code ? `${code} ${amount}` : amount;
}

export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${formatNumber(value * 100, digits)}%`;
}

export function formatMultiple(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${formatNumber(value, digits)}x`;
}

export function daysBetweenInclusive(start: string, end: string): number {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 0;
  return Math.round((endMs - startMs) / 86_400_000) + 1;
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

/** Replaces characters the PDF standard fonts (WinAnsi) cannot encode. */
export function toPdfSafeText(value: string): string {
  return value
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/₹/g, "INR ")
    .replace(/ /g, " ")
    .replace(/[^\x20-\x7E\n]/g, "");
}
