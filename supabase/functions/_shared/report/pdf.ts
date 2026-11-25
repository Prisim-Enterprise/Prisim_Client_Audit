// PRISIM audit report PDF. Uses pdf-lib with the standard Helvetica fonts so
// it runs unchanged in Supabase Edge Functions (Deno) and in the browser.

import { degrees, PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import { scoreLabel } from "../audit/engine.ts";
import { formatMoney, formatMultiple, formatNumber, formatPercent, ratio, toPdfSafeText } from "../format.ts";

export type ReportFinding = {
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string;
  platform: string | null;
  title: string;
  description: string;
  recommendation: string;
  reviewerNote: string | null;
  status: string;
  estimatedImpact: number | null;
  impactCurrency: string | null;
};

export type ReportAccountKpis = {
  name: string;
  provider: string;
  currency: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
};

export type ReportCampaign = {
  name: string;
  provider: string;
  currency: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
};

export type ReportData = {
  tenantName: string;
  title: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  published: boolean;
  overallScore: number | null;
  platformScores: Record<string, number>;
  categoryScores: Record<string, number>;
  summary: string | null;
  accounts: ReportAccountKpis[];
  findings: ReportFinding[];
  campaigns: ReportCampaign[];
  engineVersion: string;
  /** Demo fixtures only. Adds a watermark on every page. */
  synthetic?: boolean;
};

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;

const COLORS = {
  ink: rgb(0.063, 0.102, 0.169),
  slate: rgb(0.392, 0.455, 0.545),
  light: rgb(0.886, 0.91, 0.941),
  faint: rgb(0.965, 0.973, 0.98),
  accent: rgb(0.067, 0.459, 0.392),
  accentLight: rgb(0.847, 0.953, 0.933),
  white: rgb(1, 1, 1),
  critical: rgb(0.745, 0.071, 0.235),
  high: rgb(0.851, 0.318, 0.055),
  medium: rgb(0.792, 0.541, 0.016),
  low: rgb(0.149, 0.388, 0.922),
  info: rgb(0.392, 0.455, 0.545),
};

const SEVERITY_LABEL: Record<ReportFinding["severity"], string> = {
  critical: "CRITICAL",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
  info: "INFO",
};

const CATEGORY_LABEL: Record<string, string> = {
  tracking: "Conversion tracking",
  efficiency: "Cost efficiency",
  engagement: "Engagement & creative",
  structure: "Account structure",
  budget: "Budget management",
  trend: "Performance trend",
  data_quality: "Data quality",
};

function scoreColor(score: number) {
  if (score >= 85) return COLORS.accent;
  if (score >= 70) return COLORS.low;
  if (score >= 50) return COLORS.medium;
  return COLORS.critical;
}

type TextOptions = {
  size?: number;
  font?: PDFFont;
  color?: ReturnType<typeof rgb>;
  x?: number;
  width?: number;
  lineHeight?: number;
};

class Writer {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];

  constructor(
    readonly doc: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
    readonly data: ReportData,
  ) {}

  newPage(withHeader = true) {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.pages.push(this.page);
    this.y = PAGE.height - MARGIN;
    if (withHeader) {
      this.page.drawText("PRISIM", { x: MARGIN, y: PAGE.height - 30, size: 9, font: this.bold, color: COLORS.accent });
      const right = toPdfSafeText(`${this.data.tenantName} - ${this.data.periodStart} to ${this.data.periodEnd}`);
      const width = this.regular.widthOfTextAtSize(right, 8);
      this.page.drawText(right, { x: PAGE.width - MARGIN - width, y: PAGE.height - 30, size: 8, font: this.regular, color: COLORS.slate });
      this.page.drawLine({
        start: { x: MARGIN, y: PAGE.height - 38 },
        end: { x: PAGE.width - MARGIN, y: PAGE.height - 38 },
        thickness: 0.5,
        color: COLORS.light,
      });
      this.y = PAGE.height - 66;
    }
  }

  ensure(height: number) {
    if (this.y - height < MARGIN + 24) this.newPage();
  }

  wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of toPdfSafeText(text).split("\n")) {
      const words = paragraph.split(/\s+/).filter(Boolean);
      let line = "";
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= width) {
          line = candidate;
          continue;
        }
        if (line) lines.push(line);
        // Break words longer than the line.
        let rest = word;
        while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
          let cut = rest.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--;
          lines.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      }
      lines.push(line);
    }
    return lines;
  }

  text(value: string, options: TextOptions = {}) {
    const size = options.size ?? 10;
    const font = options.font ?? this.regular;
    const x = options.x ?? MARGIN;
    const width = options.width ?? CONTENT_WIDTH - (x - MARGIN);
    const lineHeight = options.lineHeight ?? size * 1.45;
    for (const line of this.wrap(value, font, size, width)) {
      this.ensure(lineHeight);
      this.page.drawText(line, { x, y: this.y - size, size, font, color: options.color ?? COLORS.ink });
      this.y -= lineHeight;
    }
  }

  heading(value: string, kicker?: string) {
    this.ensure(60);
    if (kicker) {
      this.text(kicker.toUpperCase(), { size: 8, font: this.bold, color: COLORS.accent });
      this.y -= 2;
    }
    this.text(value, { size: 18, font: this.bold });
    this.y -= 8;
  }

  space(amount: number) {
    this.y -= amount;
  }
}

function pill(writer: Writer, label: string, x: number, y: number, color: ReturnType<typeof rgb>) {
  const size = 7;
  const width = writer.bold.widthOfTextAtSize(label, size) + 10;
  writer.page.drawRectangle({ x, y: y - 3, width, height: 13, color });
  writer.page.drawText(label, { x: x + 5, y: y + 0.5, size, font: writer.bold, color: COLORS.white });
  return width;
}

function drawCover(writer: Writer) {
  const { data } = writer;
  writer.newPage(false);
  const page = writer.page;
  page.drawRectangle({ x: 0, y: PAGE.height - 300, width: PAGE.width, height: 300, color: COLORS.ink });
  page.drawText("PRISIM", { x: MARGIN, y: PAGE.height - 70, size: 14, font: writer.bold, color: COLORS.accentLight });
  page.drawText("CLIENT AUDIT PORTAL", { x: MARGIN, y: PAGE.height - 86, size: 8, font: writer.regular, color: COLORS.light });
  page.drawText("Advertising Audit Report", { x: MARGIN, y: PAGE.height - 160, size: 30, font: writer.bold, color: COLORS.white });
  writer.y = PAGE.height - 180;
  writer.text(data.tenantName, { size: 16, font: writer.regular, color: COLORS.accentLight });
  writer.text(`${data.title}  |  ${data.periodStart} to ${data.periodEnd}`, { size: 10, color: COLORS.light });

  // Score ring
  const score = data.overallScore;
  const centerX = MARGIN + 70;
  const centerY = PAGE.height - 420;
  page.drawCircle({ x: centerX, y: centerY, size: 62, borderColor: COLORS.light, borderWidth: 10 });
  if (score !== null) {
    page.drawCircle({ x: centerX, y: centerY, size: 62, borderColor: scoreColor(score), borderWidth: 10, borderOpacity: 0.95 });
    const label = formatNumber(score, 0);
    const width = writer.bold.widthOfTextAtSize(label, 34);
    page.drawText(label, { x: centerX - width / 2, y: centerY - 8, size: 34, font: writer.bold, color: COLORS.ink });
    const of = "/ 100";
    page.drawText(of, { x: centerX - writer.regular.widthOfTextAtSize(of, 9) / 2, y: centerY - 24, size: 9, font: writer.regular, color: COLORS.slate });
  }
  writer.y = centerY + 50;
  const textX = centerX + 100;
  writer.text("OVERALL ACCOUNT HEALTH", { x: textX, size: 8, font: writer.bold, color: COLORS.accent });
  writer.text(score === null ? "Not scored" : scoreLabel(score), { x: textX, size: 20, font: writer.bold });
  const platforms = Object.entries(data.platformScores);
  if (platforms.length > 0) {
    writer.space(4);
    writer.text(
      platforms.map(([platform, value]) => `${platform === "meta" ? "Meta Ads" : "Google Ads"}: ${formatNumber(value, 0)}/100`).join("     "),
      { x: textX, size: 10, color: COLORS.slate },
    );
  }

  const counts = data.findings.reduce<Record<string, number>>((acc, finding) => {
    acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
    return acc;
  }, {});
  writer.y = centerY - 110;
  let x = MARGIN;
  for (const severity of ["critical", "high", "medium", "low"] as const) {
    page.drawRectangle({ x, y: writer.y - 52, width: 116, height: 52, color: COLORS.faint, borderColor: COLORS.light, borderWidth: 0.5 });
    page.drawText(String(counts[severity] ?? 0), { x: x + 12, y: writer.y - 30, size: 20, font: writer.bold, color: COLORS[severity] });
    page.drawText(`${SEVERITY_LABEL[severity]} PRIORITY`, { x: x + 12, y: writer.y - 44, size: 7, font: writer.bold, color: COLORS.slate });
    x += 124;
  }

  writer.y = MARGIN + 90;
  if (!data.published) {
    writer.text("DRAFT - under PRISIM review. Not yet approved for client distribution.", { size: 9, font: writer.bold, color: COLORS.high });
  }
  writer.text(`Generated ${data.generatedAt.slice(0, 16).replace("T", " ")} UTC  |  Engine ${data.engineVersion}`, { size: 8, color: COLORS.slate });
  writer.text("Confidential - prepared for the named client by PRISIM.", { size: 8, color: COLORS.slate });
}

function drawSummary(writer: Writer) {
  const { data } = writer;
  writer.newPage();
  writer.heading("Executive summary", "Overview");
  writer.text(data.summary ?? "No summary was provided for this audit.", { size: 10.5, lineHeight: 16 });
  writer.space(16);

  const currencies = new Set(data.accounts.map((account) => account.currency ?? ""));
  if (data.accounts.length > 0 && currencies.size === 1) {
    const currency = data.accounts[0].currency;
    const total = data.accounts.reduce(
      (acc, account) => ({
        spend: acc.spend + account.spend,
        impressions: acc.impressions + account.impressions,
        clicks: acc.clicks + account.clicks,
        conversions: acc.conversions + account.conversions,
        value: acc.value + account.conversionValue,
      }),
      { spend: 0, impressions: 0, clicks: 0, conversions: 0, value: 0 },
    );
    const tiles: Array<[string, string]> = [
      ["Spend", formatMoney(total.spend, currency, 0)],
      ["Conversions", formatNumber(total.conversions, 0)],
      ["Cost / conversion", formatMoney(ratio(total.spend, total.conversions), currency)],
      ["ROAS", total.value > 0 ? formatMultiple(ratio(total.value, total.spend)) : "Not tracked"],
      ["Impressions", formatNumber(total.impressions)],
      ["Clicks", formatNumber(total.clicks)],
      ["CTR", formatPercent(ratio(total.clicks, total.impressions))],
      ["Cost / click", formatMoney(ratio(total.spend, total.clicks), currency)],
    ];
    drawTiles(writer, tiles);
  } else if (data.accounts.length > 0) {
    writer.text("Accounts use different currencies, so totals are reported per account below.", { size: 9, color: COLORS.slate });
  }

  writer.space(14);
  writer.text("SCORE BY AREA", { size: 8, font: writer.bold, color: COLORS.accent });
  writer.space(6);
  for (const [category, value] of Object.entries(data.categoryScores)) {
    writer.ensure(22);
    const y = writer.y - 10;
    writer.page.drawText(toPdfSafeText(CATEGORY_LABEL[category] ?? category), { x: MARGIN, y, size: 9, font: writer.regular, color: COLORS.ink });
    const barX = MARGIN + 150;
    const barWidth = CONTENT_WIDTH - 190;
    writer.page.drawRectangle({ x: barX, y: y - 1, width: barWidth, height: 8, color: COLORS.light });
    writer.page.drawRectangle({ x: barX, y: y - 1, width: Math.max(2, (barWidth * Math.min(Math.max(value, 0), 100)) / 100), height: 8, color: scoreColor(value) });
    writer.page.drawText(formatNumber(value, 0), { x: barX + barWidth + 10, y, size: 9, font: writer.bold, color: COLORS.ink });
    writer.y -= 20;
  }

  writer.space(14);
  writer.text("AD ACCOUNTS REVIEWED", { size: 8, font: writer.bold, color: COLORS.accent });
  writer.space(6);
  drawTable(
    writer,
    ["Account", "Platform", "Spend", "Conv.", "CPA", "ROAS"],
    [0.34, 0.14, 0.16, 0.1, 0.14, 0.12],
    data.accounts.map((account) => [
      account.name,
      account.provider === "meta" ? "Meta" : "Google",
      formatMoney(account.spend, account.currency, 0),
      formatNumber(account.conversions, 0),
      formatMoney(ratio(account.spend, account.conversions), account.currency),
      account.conversionValue > 0 ? formatMultiple(ratio(account.conversionValue, account.spend)) : "-",
    ]),
  );
}

function drawTiles(writer: Writer, tiles: Array<[string, string]>) {
  const columns = 4;
  const gap = 8;
  const width = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
  const height = 48;
  for (let index = 0; index < tiles.length; index += columns) {
    writer.ensure(height + gap);
    tiles.slice(index, index + columns).forEach(([label, value], column) => {
      const x = MARGIN + column * (width + gap);
      writer.page.drawRectangle({ x, y: writer.y - height, width, height, color: COLORS.faint, borderColor: COLORS.light, borderWidth: 0.5 });
      writer.page.drawText(toPdfSafeText(label.toUpperCase()), { x: x + 10, y: writer.y - 16, size: 7, font: writer.bold, color: COLORS.slate });
      const fitted = fit(writer.bold, toPdfSafeText(value), 13, width - 20);
      writer.page.drawText(fitted.text, { x: x + 10, y: writer.y - 36, size: fitted.size, font: writer.bold, color: COLORS.ink });
    });
    writer.y -= height + gap;
  }
}

function fit(font: PDFFont, text: string, size: number, width: number) {
  let current = size;
  while (current > 6 && font.widthOfTextAtSize(text, current) > width) current -= 0.5;
  let value = text;
  while (value.length > 1 && font.widthOfTextAtSize(value, current) > width) value = `${value.slice(0, -2)}.`;
  return { text: value, size: current };
}

function drawTable(writer: Writer, headers: string[], fractions: number[], rows: string[][]) {
  const widths = fractions.map((fraction) => fraction * CONTENT_WIDTH);
  const rowHeight = 18;
  const drawHeader = () => {
    writer.ensure(rowHeight * 2);
    writer.page.drawRectangle({ x: MARGIN, y: writer.y - rowHeight, width: CONTENT_WIDTH, height: rowHeight, color: COLORS.ink });
    let x = MARGIN;
    headers.forEach((header, index) => {
      writer.page.drawText(header.toUpperCase(), { x: x + 6, y: writer.y - 12, size: 7, font: writer.bold, color: COLORS.white });
      x += widths[index];
    });
    writer.y -= rowHeight;
  };
  drawHeader();
  rows.forEach((row, rowIndex) => {
    if (writer.y - rowHeight < MARGIN + 24) {
      writer.newPage();
      drawHeader();
    }
    if (rowIndex % 2 === 1) {
      writer.page.drawRectangle({ x: MARGIN, y: writer.y - rowHeight, width: CONTENT_WIDTH, height: rowHeight, color: COLORS.faint });
    }
    let x = MARGIN;
    row.forEach((cell, index) => {
      const fitted = fit(writer.regular, toPdfSafeText(cell), 8, widths[index] - 12);
      writer.page.drawText(fitted.text, { x: x + 6, y: writer.y - 12, size: fitted.size, font: writer.regular, color: COLORS.ink });
      x += widths[index];
    });
    writer.y -= rowHeight;
  });
  if (rows.length === 0) writer.text("No data for this period.", { size: 9, color: COLORS.slate });
}

function drawFindings(writer: Writer) {
  const { data } = writer;
  writer.newPage();
  writer.heading("Findings and recommendations", "Audit detail");
  const findings = data.findings.filter((finding) => finding.status !== "dismissed");
  if (findings.length === 0) {
    writer.text("No issues were identified by the audit for this period.", { size: 10, color: COLORS.slate });
    return;
  }
  findings.forEach((finding, index) => {
    writer.ensure(90);
    const top = writer.y;
    let x = MARGIN;
    x += pill(writer, SEVERITY_LABEL[finding.severity], x, top - 10, COLORS[finding.severity]) + 6;
    const meta = [CATEGORY_LABEL[finding.category] ?? finding.category, finding.platform === "meta" ? "Meta Ads" : finding.platform === "google" ? "Google Ads" : null]
      .filter(Boolean)
      .join("  |  ");
    writer.page.drawText(toPdfSafeText(meta), { x, y: top - 9.5, size: 8, font: writer.regular, color: COLORS.slate });
    if (finding.status === "resolved" || finding.status === "accepted") {
      const label = finding.status === "resolved" ? "RESOLVED" : "ACCEPTED";
      const width = writer.bold.widthOfTextAtSize(label, 7) + 10;
      pill(writer, label, PAGE.width - MARGIN - width, top - 10, COLORS.accent);
    }
    writer.y = top - 22;
    writer.text(`${index + 1}. ${finding.title}`, { size: 11.5, font: writer.bold, lineHeight: 15 });
    writer.space(2);
    writer.text(finding.description, { size: 9.5, color: COLORS.slate, lineHeight: 14 });
    writer.space(4);
    writer.text("Recommendation", { size: 8, font: writer.bold, color: COLORS.accent });
    writer.text(finding.recommendation, { size: 9.5, lineHeight: 14 });
    if (finding.estimatedImpact && finding.impactCurrency) {
      writer.space(2);
      writer.text(`Spend at risk: ${formatMoney(finding.estimatedImpact, finding.impactCurrency, 0)}`, { size: 9, font: writer.bold, color: COLORS.high });
    }
    if (finding.reviewerNote) {
      writer.space(2);
      writer.text(`PRISIM reviewer note: ${finding.reviewerNote}`, { size: 9, color: COLORS.ink, lineHeight: 13 });
    }
    writer.space(10);
    writer.ensure(12);
    writer.page.drawLine({ start: { x: MARGIN, y: writer.y + 4 }, end: { x: PAGE.width - MARGIN, y: writer.y + 4 }, thickness: 0.5, color: COLORS.light });
    writer.space(8);
  });
}

function drawCampaigns(writer: Writer) {
  const { data } = writer;
  writer.newPage();
  writer.heading("Campaign performance", "Appendix");
  writer.text("Top campaigns by spend in the audit period.", { size: 9, color: COLORS.slate });
  writer.space(8);
  const rows = [...data.campaigns]
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 25)
    .map((campaign) => [
      campaign.name,
      campaign.provider === "meta" ? "Meta" : "Google",
      formatMoney(campaign.spend, campaign.currency, 0),
      formatNumber(campaign.impressions),
      formatPercent(ratio(campaign.clicks, campaign.impressions)),
      formatNumber(campaign.conversions, 0),
      formatMoney(ratio(campaign.spend, campaign.conversions), campaign.currency),
      campaign.conversionValue > 0 ? formatMultiple(ratio(campaign.conversionValue, campaign.spend)) : "-",
    ]);
  drawTable(writer, ["Campaign", "Platform", "Spend", "Impr.", "CTR", "Conv.", "CPA", "ROAS"], [0.28, 0.09, 0.13, 0.11, 0.08, 0.08, 0.13, 0.1], rows);

  writer.space(24);
  writer.text("METHODOLOGY", { size: 8, font: writer.bold, color: COLORS.accent });
  writer.space(4);
  writer.text(
    "Figures come from the Meta Marketing API and Google Ads API, synchronized daily at campaign level. " +
      "Conversions and conversion value are reported as attributed by each platform and are not de-duplicated across platforms. " +
      "Scores start at 100 per area and are reduced by each finding according to its severity and the share of spend it affects; " +
      "the overall score weights tracking and cost efficiency most heavily. Benchmarks are conservative industry medians and should be " +
      "read alongside the business's own targets. Findings were reviewed by PRISIM before publication.",
    { size: 8.5, color: COLORS.slate, lineHeight: 12.5 },
  );
}

function decorate(writer: Writer) {
  const total = writer.pages.length;
  writer.pages.forEach((page, index) => {
    if (index > 0) {
      const label = `Page ${index + 1} of ${total}`;
      page.drawText(label, {
        x: PAGE.width - MARGIN - writer.regular.widthOfTextAtSize(label, 8),
        y: 26,
        size: 8,
        font: writer.regular,
        color: COLORS.slate,
      });
      page.drawText("PRISIM Advertising Audit - Confidential", { x: MARGIN, y: 26, size: 8, font: writer.regular, color: COLORS.slate });
    }
    if (writer.data.synthetic) {
      page.drawText("SYNTHETIC DEMO DATA - NOT REAL CLIENT RESULTS", {
        x: 92,
        y: 210,
        size: 26,
        font: writer.bold,
        color: COLORS.critical,
        opacity: 0.16,
        rotate: degrees(45),
      });
    }
  });
}

export async function buildAuditReportPdf(data: ReportData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(toPdfSafeText(`${data.tenantName} - ${data.title}`));
  doc.setAuthor("PRISIM");
  doc.setSubject(data.synthetic ? "Synthetic demo advertising audit (not real data)" : "Advertising audit report");
  doc.setCreator("PRISIM Client Audit Portal");
  doc.setProducer("PRISIM Client Audit Portal");
  doc.setCreationDate(new Date(data.generatedAt));
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const writer = new Writer(doc, regular, bold, data);
  drawCover(writer);
  drawSummary(writer);
  drawFindings(writer);
  drawCampaigns(writer);
  decorate(writer);
  return doc.save();
}
