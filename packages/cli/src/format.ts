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

/** Project totals matching the terminal table, with a total row and spreadsheet-safe cells. */
export function csv(report: UsageReport): string {
  const summary = projectSummary(report, false);

  const headings = summary.headings.map((heading) =>
    heading === "API estimate" ? "API estimate (USD)" : heading,
  );

  return [headings, ...summary.rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function terminalText(value: string): string {
  // eslint-disable-next-line no-control-regex -- Provider metadata must not emit terminal control sequences.
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function projectSummary(report: UsageReport, grouped: boolean) {
  const projects = new Map<string, { tokens: typeof zeroTokens; cost: number; unpriced: number }>();

  for (const row of report.rows) {
    const previous = projects.get(row.project);
    projects.set(row.project, {
      tokens: addTokens(previous?.tokens ?? zeroTokens, row.tokens),
      cost: (previous?.cost ?? 0) + row.pricedCostUsd,
      unpriced: (previous?.unpriced ?? 0) + row.unpricedRecords,
    });
  }

  const cost = [...projects.values()].reduce((sum, project) => sum + project.cost, 0);
  const unpriced = [...projects.values()].reduce((sum, project) => sum + project.unpriced, 0);

  const headings = [
    "Project",
    "Input",
    "Cache read",
    "Cache write",
    "Output",
    "API estimate",
    unpriced ? "Known cost %" : "Cost %",
  ];

  const percentage = new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

  const share = (value: number) => (cost > 0 ? percentage.format(value / cost) : "—");
  const number = new Intl.NumberFormat("en-US", { useGrouping: grouped });

  const dollars = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    useGrouping: grouped,
  });

  let allTokens = zeroTokens;
  const rows: string[][] = [];

  const ranked = [...projects].toSorted(
    ([leftProject, left], [rightProject, right]) =>
      right.cost - left.cost || leftProject.localeCompare(rightProject),
  );

  for (const [project, total] of ranked) {
    rows.push([
      project,
      number.format(total.tokens.input),
      number.format(total.tokens.cacheRead),
      number.format(total.tokens.cacheWrite),
      number.format(total.tokens.output),
      `${dollars.format(total.cost)}${total.unpriced ? " + unknown" : ""}`,
      share(total.cost),
    ]);
    allTokens = addTokens(allTokens, total.tokens);
  }

  if (projects.size > 0)
    rows.push([
      "Total",
      number.format(allTokens.input),
      number.format(allTokens.cacheRead),
      number.format(allTokens.cacheWrite),
      number.format(allTokens.output),
      `${dollars.format(cost)}${unpriced ? " + unknown" : ""}`,
      share(cost),
    ]);

  return { headings, rows, allTokens, unpriced, projectCount: projects.size };
}

/** Per-project totals fitted to terminal columns, sorted by known API cost, with optional styling and sanitized identifiers. */
export function table(report: UsageReport, columns = 120, colorful = false): string {
  const paint = (format: Parameters<typeof styleText>[0], value: string) =>
    colorful ? styleText(format, value, { validateStream: false }) : value;

  const { headings, rows, allTokens, unpriced, projectCount } = projectSummary(report, true);
  const number = new Intl.NumberFormat("en-US");

  if (projectCount === 0)
    return `No observed usage from ${report.since} through ${report.until} (UTC).`;

  const numericWidths = headings
    .slice(1)
    .map(
      (heading, i) => Math.max(heading.length, ...rows.map((row) => row[i + 1]?.length ?? 0)) + 2,
    );

  // Each column adds a border; leave at least 20 characters for project names.
  const projectWidth =
    columns - numericWidths.reduce((sum, width) => sum + width, 0) - (headings.length + 1);

  const narrow = projectWidth < 22;

  const colWidths = narrow
    ? [16, Math.max(4, columns - 19)]
    : [Math.min(50, projectWidth), ...numericWidths];

  const output = new Table({
    head: narrow ? [] : headings.map((heading) => paint(["bold", "cyan"], heading)),
    colWidths,
    colAligns: narrow
      ? ["left", "right"]
      : ["left", "right", "right", "right", "right", "right", "right"],
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
      const cell = wrapAnsi(terminalText(value), Math.max(2, width), {
        hard: true,
        wordWrap: false,
        trim: false,
      });

      if (index === rows.length - 1) return paint(["bold", "magenta"], cell);

      if (column === 0) return paint(projectColors[index % projectColors.length] ?? "cyan", cell);

      if (column >= headings.length - 2)
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
      `${colorful ? "📊 " : ""}${number.format(totalTokens(allTokens))} observed tokens · ${number.format(projectCount)} ${projectCount === 1 ? "project" : "projects"}`,
    ),
    ...(unpriced > 0
      ? [
          paint(
            "yellow",
            "Incomplete pricing: sorting and percentages use known API subtotals; unknown costs are additional.",
          ),
        ]
      : []),
    paint("dim", "USD API-equivalent estimates; not your subscription bill."),
  ].join("\n");
}
