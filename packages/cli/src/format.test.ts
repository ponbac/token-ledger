import { assert, it } from "@effect/vitest";
import { ReportRow, UsageReport } from "@token-ledger/core/model";

import { table } from "./format.ts";

function report(costs: readonly number[], unpriced = false) {
  return UsageReport.make({
    version: 1,
    since: "2026-09-01",
    until: "2026-09-30",
    currency: "USD",
    costBasis: "api-equivalent",
    pricing: { status: "custom", fetchedAt: null, source: "fixture" },
    coverage: [],
    rows: costs.map((cost, index) =>
      ReportRow.make({
        project: index < 2 ? "Alpha" : "Beta",
        day: "2026-09-22",
        provider: "copilot",
        model: `model-${index}`,
        pricePerMillion: null,
        tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
        records: 1,
        estimatedCostUsd: unpriced ? null : cost,
        pricedCostUsd: cost,
        unpricedRecords: unpriced ? 1 : 0,
      }),
    ),
  });
}

it("shows each project's share of the unrounded total in wide and narrow tables", () => {
  for (const columns of [160, 60]) {
    const output = table(report([0.001, 0.002, 0.007]), columns);
    assert.include(output, "Cost %");
    assert.match(output, /Beta[\s\S]*70\.0%[\s\S]*Alpha[\s\S]*30\.0%[\s\S]*Total[\s\S]*100\.0%/);
  }
});

it("labels shares of incomplete pricing and leaves a zero denominator undefined", () => {
  const partial = table(report([1, 2, 7], true), 160);
  assert.include(partial, "Known cost %");
  assert.include(partial, "30.0%");
  assert.include(partial, "percentages use known API subtotals");

  for (const unpriced of [false, true]) {
    const zero = table(report([0, 0, 0], unpriced), 160);
    assert.notMatch(zero, /\d\.\d%|NaN|Infinity/);
    assert.include(zero, "—");
  }
});
