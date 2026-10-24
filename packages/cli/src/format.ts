import { styleText } from "node:util";

import {
  addTokens,
  totalTokens,
  zeroTokens,
  type ReportRequest,
  type ReportRow,
  type UsageReport,
} from "@token-ledger/core/model";
import type { SyncPayload } from "@token-ledger/core/sync";
import { Option } from "effect";
import Table from "cli-table3";
import wrapAnsi from "wrap-ansi";

import { RepriceOutcome } from "./reprice.ts";

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
    return `No observed usage from ${report.since} through ${report.until} (${report.timeZone}).`;

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
    `${paint(["bold", "cyan"], colorful ? "⚡ Token Ledger" : "Token Ledger")} · ${paint("dim", `${report.since} through ${report.until} (${report.timeZone})`)}`,
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

/** What a sync uploaded, for a person or a scheduler's log; the token never appears. */
export function syncSummary(
  payload: SyncPayload,
  request: ReportRequest,
  storedBuckets: Option.Option<number>,
): string {
  const number = new Intl.NumberFormat("en-US");
  const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const sessions = new Set(payload.buckets.map((bucket) => bucket.sessionKey)).size;

  const cost = payload.buckets.reduce((sum, bucket) => sum + (bucket.estimatedCostUsd ?? 0), 0);

  const unknown = payload.buckets.some((bucket) => bucket.unpricedRecords > 0);

  return [
    `Synced ${terminalText(payload.machine.label)} · ${request.since} through ${request.until} (${payload.timeZone})`,
    [
      `${number.format(payload.buckets.length)} hourly buckets`,
      `${number.format(sessions)} sessions`,
      `${dollars.format(cost)}${unknown ? " + unknown" : ""} API estimate`,
      Option.match(storedBuckets, {
        onNone: () => "accepted by the server",
        onSome: (stored) => `server stored ${number.format(stored)}`,
      }),
    ].join(" · "),
  ].join("\n");
}

/**
 * Names the models with unpriced usage, most unpriced records first, or `undefined` when all
 * usage was priced. Models without a published price, such as Codex's `codex-auto-review`, stay
 * unpriced until configured.
 */
export function unpricedModels(
  rows: ReadonlyArray<Pick<ReportRow, "provider" | "model" | "unpricedRecords">>,
): string | undefined {
  const counts = new Map<string, number>();

  for (const row of rows)
    if (row.unpricedRecords > 0) {
      const name = `${terminalText(row.model)} (${row.provider}`;
      counts.set(name, (counts.get(name) ?? 0) + row.unpricedRecords);
    }

  if (counts.size === 0) return undefined;
  const number = new Intl.NumberFormat("en-US");

  const ranked = [...counts]
    .toSorted(
      ([leftName, left], [rightName, right]) => right - left || leftName.localeCompare(rightName),
    )
    .map(
      ([name, records]) =>
        `${name}, ${number.format(records)} ${records === 1 ? "record" : "records"})`,
    );

  const shown = ranked.slice(0, 5).join(", ");
  const more = ranked.length > 5 ? ` and ${ranked.length - 5} more` : "";

  return `Unpriced: ${shown}${more}. Configure their rates under "prices" to price them.`;
}

/** A whole UTC hour, such as `2026-10-03 14:00 UTC`. */
function utcHour(instant: number): string {
  return `${new Date(instant).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** One line of a sync's output about repricing, and whether it reports a problem. */
export interface RepriceLine {
  readonly text: string;
  /** Problems go to stderr; repricing never changes a sync's exit code. */
  readonly problem: boolean;
}

/**
 * Describes what happened to stored usage that an older pricing basis priced, for a person or
 * a scheduler's log. It names providers, hours, counts, and the server's origin only: never a
 * token, a local path, or anything from a history.
 */
export function repriceLine(outcome: RepriceOutcome): RepriceLine {
  const number = new Intl.NumberFormat("en-US");

  const buckets = (count: number) =>
    `${number.format(count)} ${count === 1 ? "bucket" : "buckets"}`;

  return RepriceOutcome.$match(outcome, {
    Repriced: ({ provider, from, staleBuckets, sent, updated, unmatched, beforeFloor }) => ({
      text: [
        `Repriced ${provider} from ${utcHour(from)}`,
        `${buckets(staleBuckets)} stored on an older pricing basis`,
        `sent ${number.format(sent)}`,
        `${number.format(updated)} updated`,
        `${number.format(unmatched)} unmatched`,
        ...(beforeFloor > 0 ? [`${number.format(beforeFloor)} before the server's floor`] : []),
      ].join(" · "),
      problem: false,
    }),
    Skipped: ({ provider, from, staleBuckets }) => ({
      text: `Repricing ${provider} skipped: this machine already sent its usage from ${utcHour(from)} on this pricing basis, and cannot reproduce the ${buckets(staleBuckets)} still stored on an older one.`,
      problem: false,
    }),
    NoHistory: ({ provider, from, staleBuckets }) => ({
      text: `Repricing ${provider} from ${utcHour(from)} waits: this machine found no ${provider} history to rebuild the ${buckets(staleBuckets)} stored on an older pricing basis. The next sync looks again.`,
      problem: false,
    }),
    Failed: ({ provider, from, message, updated, unmatched }) => ({
      text: `Repricing ${provider} from ${utcHour(from)} did not finish: ${message}${
        updated + unmatched > 0
          ? ` Before that, ${number.format(updated)} updated and ${number.format(unmatched)} unmatched.`
          : ""
      } The next sync tries again.`,
      problem: true,
    }),
    Unanswered: ({ message }) => ({
      text: `Could not ask the server what to reprice: ${message} The next sync asks again.`,
      problem: true,
    }),
    Unremembered: ({ message }) => ({
      text: `${message} The next sync sends its reprices again.`,
      problem: true,
    }),
  });
}
