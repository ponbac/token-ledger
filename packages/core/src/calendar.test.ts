import { assert, describe, it } from "@effect/vitest";
import { DateTime } from "effect";

import { dayWindow } from "./calendar.ts";

const stockholm = DateTime.zoneMakeNamedUnsafe("Europe/Stockholm");

const hours = 3_600_000;

describe("dayWindow", () => {
  it("bounds 23- and 25-hour Stockholm days at local midnight", () => {
    const spring = dayWindow("2026-03-29", "2026-03-29", stockholm);
    assert.strictEqual(spring.start, Date.parse("2026-03-28T23:00:00Z"));
    assert.strictEqual(spring.end - spring.start, 23 * hours);

    const autumn = dayWindow("2026-10-25", "2026-10-25", stockholm);
    assert.strictEqual(autumn.start, Date.parse("2026-10-24T22:00:00Z"));
    assert.strictEqual(autumn.end - autumn.start, 25 * hours);
  });

  it("assigns instants to local days across DST transitions and a month boundary", () => {
    const window = dayWindow("2026-03-28", "2026-10-31", stockholm);

    for (const [instant, day] of [
      ["2026-03-28T22:59:59.999Z", "2026-03-28"],
      ["2026-03-28T23:00:00.000Z", "2026-03-29"],
      ["2026-03-29T01:00:00.000Z", "2026-03-29"],
      ["2026-03-29T21:59:59.999Z", "2026-03-29"],
      ["2026-03-29T22:00:00.000Z", "2026-03-30"],
      ["2026-09-30T21:59:59.999Z", "2026-09-30"],
      ["2026-09-30T22:00:00.000Z", "2026-10-01"],
      ["2026-10-25T00:30:00.000Z", "2026-10-25"],
      ["2026-10-25T01:30:00.000Z", "2026-10-25"],
      ["2026-10-25T22:59:59.999Z", "2026-10-25"],
      ["2026-10-25T23:00:00.000Z", "2026-10-26"],
    ] as const)
      assert.strictEqual(window.dayOf(Date.parse(instant)), day, instant);

    assert.isUndefined(window.dayOf(window.start - 1));
    assert.isUndefined(window.dayOf(window.end));
  });

  it("ends a window on the last representable day", () => {
    const window = dayWindow("9999-12-30", "9999-12-31", DateTime.zoneMakeNamedUnsafe("UTC"));

    assert.strictEqual(window.dayOf(Date.parse("9999-12-31T12:00:00Z")), "9999-12-31");
    assert.strictEqual(window.end - window.start, 48 * hours);
  });

  it("round-trips astronomical years across the BCE/CE boundary in named zones", () => {
    for (const [zone, since, until, start, end] of [
      [
        "America/New_York",
        "0000-01-01",
        "0000-01-01",
        "0000-01-01T04:56:02Z",
        "0000-01-02T04:56:02Z",
      ],
      [
        "Europe/Stockholm",
        "0000-01-01",
        "0000-01-01",
        "-000001-12-31T23:06:32Z",
        "0000-01-01T23:06:32Z",
      ],
      [
        "America/New_York",
        "0000-12-31",
        "0001-01-01",
        "0000-12-31T04:56:02Z",
        "0001-01-02T04:56:02Z",
      ],
      [
        "Europe/Stockholm",
        "0000-12-31",
        "0001-01-01",
        "0000-12-30T23:06:32Z",
        "0001-01-01T23:06:32Z",
      ],
      [
        "America/New_York",
        "0001-01-01",
        "0001-01-01",
        "0001-01-01T04:56:02Z",
        "0001-01-02T04:56:02Z",
      ],
    ] as const) {
      const window = dayWindow(since, until, DateTime.zoneMakeNamedUnsafe(zone));

      assert.strictEqual(window.start, Date.parse(start), `${zone}: ${since}`);
      assert.strictEqual(window.end, Date.parse(end), `${zone}: ${until}`);
      assert.strictEqual(window.dayOf(window.start), since);
      assert.strictEqual(window.dayOf(window.end - 1), until);
      assert.isUndefined(window.dayOf(window.start - 1));
      assert.isUndefined(window.dayOf(window.end));
    }
  });

  it("starts a day with no local midnight when the clocks jump", () => {
    // São Paulo's DST began at midnight in 2018: 00:00 -03:00 became 01:00 -02:00.
    const window = dayWindow(
      "2018-11-03",
      "2018-11-04",
      DateTime.zoneMakeNamedUnsafe("America/Sao_Paulo"),
    );

    assert.strictEqual(window.dayOf(Date.parse("2018-11-04T02:59:59.999Z")), "2018-11-03");
    assert.strictEqual(window.dayOf(Date.parse("2018-11-04T03:00:00Z")), "2018-11-04");
    assert.strictEqual(window.end - window.start, 47 * hours);
  });
});
