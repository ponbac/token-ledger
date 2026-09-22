import { addTokens, totalTokens, zeroTokens, type UsageReport } from "@token-ledger/core/model";
import Table from "cli-table3";

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

/** Per-project totals fitted to terminal columns, with stacked rows on narrow terminals and sanitized identifiers. */
export function table(report: UsageReport, columns = 120): string {
  const projects = new Map<string, { tokens: typeof zeroTokens; cost: number; unpriced: number }>();

  for (const row of report.rows) {
    const previous = projects.get(row.project);
    projects.set(row.project, {
      tokens: addTokens(previous?.tokens ?? zeroTokens, row.tokens),
      cost: (previous?.cost ?? 0) + row.pricedCostUsd,
      unpriced: (previous?.unpriced ?? 0) + row.unpricedRecords,
    });
  }

  if (projects.size === 0)
    return `No observed usage from ${report.since} through ${report.until} (UTC).`;

  const headings = ["Project", "Input", "Cache read", "Cache write", "Output", "API estimate"];
  const number = new Intl.NumberFormat("en-US");
  const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  let allTokens = zeroTokens;
  let cost = 0;
  let unpriced = 0;
  const rows: string[][] = [];

  for (const [project, total] of projects) {
    rows.push([
      terminalText(project),
      number.format(total.tokens.input),
      number.format(total.tokens.cacheRead),
      number.format(total.tokens.cacheWrite),
      number.format(total.tokens.output),
      `${dollars.format(total.cost)}${total.unpriced ? " + unknown" : ""}`,
    ]);
    allTokens = addTokens(allTokens, total.tokens);
    cost += total.cost;
    unpriced += total.unpriced;
  }

  rows.push([
    "Total",
    number.format(allTokens.input),
    number.format(allTokens.cacheRead),
    number.format(allTokens.cacheWrite),
    number.format(allTokens.output),
    `${dollars.format(cost)}${unpriced ? " + unknown" : ""}`,
  ]);

  const numericWidths = headings
    .slice(1)
    .map(
      (heading, i) => Math.max(heading.length, ...rows.map((row) => row[i + 1]?.length ?? 0)) + 2,
    );

  // Six columns have seven borders; leave at least 20 characters for project names.
  const projectWidth = columns - numericWidths.reduce((sum, width) => sum + width, 0) - 7;
  const narrow = projectWidth < 22;

  const output = new Table({
    head: narrow ? [] : headings,
    colWidths: narrow
      ? [16, Math.max(4, columns - 19)]
      : [Math.min(50, projectWidth), ...numericWidths],
    colAligns: narrow ? ["left", "right"] : ["left", "right", "right", "right", "right", "right"],
    wordWrap: true,
    wrapOnWordBoundary: false,
    style: { head: [], border: [] },
  });

  for (const row of rows) {
    if (narrow) {
      output.push([{ content: row[0] ?? "", colSpan: 2, hAlign: "left" }]);

      for (const [i, heading] of headings.slice(1).entries()) {
        output.push([heading, row[i + 1] ?? ""]);
      }
    } else {
      output.push(row);
    }
  }

  return [
    `Token Ledger · ${report.since} through ${report.until} (UTC)`,
    "",
    output.toString(),
    "",
    `${number.format(totalTokens(allTokens))} observed tokens · ${number.format(projects.size)} ${projects.size === 1 ? "project" : "projects"}`,
    "USD API-equivalent estimates; not your subscription bill.",
  ].join("\n");
}
