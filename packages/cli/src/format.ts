import { addTokens, totalTokens, zeroTokens, type UsageReport } from "@token-ledger/core/model";

/** CSV cells are quoted and spreadsheet formula prefixes are escaped before export. */
function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  const safe = /^[=+\-@\t\r\n]/.test(text) ? `'${text}` : text;

  return `"${safe.replaceAll('"', '""')}"`;
}

/** One project/day/provider/model row per CSV line. Blank cost is unknown, not zero. */
export function csv(report: UsageReport): string {
  const header = [
    "project",
    "day_utc",
    "provider",
    "model",
    "input_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "output_tokens",
    "estimated_api_cost_usd",
    "priced_subtotal_usd",
    "unpriced_records",
  ];

  const rows = report.rows.map((row) =>
    [
      row.project,
      row.day,
      row.provider,
      row.model,
      row.tokens.input,
      row.tokens.cacheRead,
      row.tokens.cacheWrite,
      row.tokens.output,
      row.estimatedCostUsd,
      row.pricedCostUsd,
      row.unpricedRecords,
    ]
      .map(csvCell)
      .join(","),
  );

  return [header.join(","), ...rows].join("\n");
}

function terminalText(value: string): string {
  // eslint-disable-next-line no-control-regex -- Provider metadata must not emit terminal control sequences.
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

/** Human-readable per-project totals. Terminal control characters in project identifiers are neutralized. */
export function table(report: UsageReport): string {
  const projects = new Map<string, { tokens: typeof zeroTokens; cost: number; unpriced: number }>();

  for (const row of report.rows) {
    const previous = projects.get(row.project);
    projects.set(row.project, {
      tokens: addTokens(previous?.tokens ?? zeroTokens, row.tokens),
      cost: (previous?.cost ?? 0) + row.pricedCostUsd,
      unpriced: (previous?.unpriced ?? 0) + row.unpricedRecords,
    });
  }

  const rows = [["Project", "Input", "Cache read", "Cache write", "Output", "API estimate"]];
  const number = new Intl.NumberFormat("en-US");
  let tokens = 0;

  for (const [project, total] of projects) {
    rows.push([
      terminalText(project),
      number.format(total.tokens.input),
      number.format(total.tokens.cacheRead),
      number.format(total.tokens.cacheWrite),
      number.format(total.tokens.output),
      total.unpriced ? `$${total.cost.toFixed(2)} + unknown` : `$${total.cost.toFixed(2)}`,
    ]);
    tokens += totalTokens(total.tokens);
  }

  if (projects.size === 0)
    return `No observed usage from ${report.since} through ${report.until} (UTC).`;
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((row) => row[i]?.length ?? 0))) ?? [];

  return [
    `${report.since} through ${report.until} (UTC)`,
    "",
    ...rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ")),
    "",
    `${number.format(tokens)} observed tokens. USD API-equivalent estimates; not your subscription bill.`,
  ].join("\n");
}
