import { styleText } from "node:util";

import { addTokens, totalTokens, zeroTokens, type UsageReport } from "@token-ledger/core/model";
import Table from "cli-table3";
import wrapAnsi from "wrap-ansi";

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

/** Per-project totals fitted to terminal columns, sorted by known API cost, with optional styling and sanitized identifiers. */
export function table(report: UsageReport, columns = 120, colorful = false): string {
  const paint = (format: Parameters<typeof styleText>[0], value: string) =>
    colorful ? styleText(format, value, { validateStream: false }) : value;

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

  const ranked = [...projects].toSorted(
    ([leftProject, left], [rightProject, right]) =>
      right.cost - left.cost || leftProject.localeCompare(rightProject),
  );

  for (const [project, total] of ranked) {
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

  const colWidths = narrow
    ? [16, Math.max(4, columns - 19)]
    : [Math.min(50, projectWidth), ...numericWidths];

  const output = new Table({
    head: narrow ? [] : headings.map((heading) => paint(["bold", "cyan"], heading)),
    colWidths,
    colAligns: narrow ? ["left", "right"] : ["left", "right", "right", "right", "right", "right"],
    wordWrap: false,
    style: { head: [], border: [] },
  });

  const projectColors = [
    "cyan",
    "blueBright",
    "magenta",
    "yellow",
    "green",
    "cyanBright",
  ] satisfies readonly Parameters<typeof styleText>[0][];

  for (const [index, row] of rows.entries()) {
    const styled = row.map((value, column) => {
      const width = narrow
        ? column === 0
          ? columns - 4
          : columns - 21
        : (colWidths[column] ?? 4) - 2;

      // cli-table3's hard wrapping splits ANSI sequences; wrap before styling instead.
      const cell = wrapAnsi(value, Math.max(2, width), {
        hard: true,
        wordWrap: false,
        trim: false,
      });

      if (index === rows.length - 1) return paint(["bold", "magenta"], cell);

      if (column === 0) return paint(projectColors[index % projectColors.length] ?? "cyan", cell);

      if (column === headings.length - 1)
        return paint(value.includes("unknown") ? "yellow" : "green", cell);

      return cell === "0" ? paint("dim", cell) : cell;
    });

    if (narrow) {
      output.push([{ content: styled[0] ?? "", colSpan: 2, hAlign: "left" }]);

      for (const [i, heading] of headings.slice(1).entries()) {
        output.push([paint("cyan", heading), styled[i + 1] ?? ""]);
      }
    } else {
      output.push(styled);
    }
  }

  return [
    `${paint(["bold", "cyan"], colorful ? "⚡ Token Ledger" : "Token Ledger")} · ${paint("dim", `${report.since} through ${report.until} (UTC)`)}`,
    "",
    output.toString(),
    "",
    paint(
      "bold",
      `${colorful ? "📊 " : ""}${number.format(totalTokens(allTokens))} observed tokens · ${number.format(projects.size)} ${projects.size === 1 ? "project" : "projects"}`,
    ),
    ...(unpriced > 0
      ? [
          paint(
            "yellow",
            "Incomplete pricing: sorted by known API subtotal; unknown costs are additional.",
          ),
        ]
      : []),
    paint("dim", "USD API-equivalent estimates; not your subscription bill."),
  ].join("\n");
}
